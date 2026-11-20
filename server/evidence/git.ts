// Git, read only (spec 27.3). Three safeguards, because a repository's own
// configuration can make git run programs:
//   1. only the subcommands in READ_ONLY are ever run;
//   2. the environment is rebuilt, with the user and system config ignored,
//      no pager, no optional locks (so `diff` does not rewrite the index), no
//      terminal prompts, and literal pathspecs (no `:(…)` magic);
//   3. `-c` overrides turn off the repository-config hooks that execute
//      commands (fsmonitor, hooks path, pager), and every diff is run with
//      --no-ext-diff and --no-textconv at the call site.
//   4. Clean/smudge filters are named by attributes and defined in config, and
//      `diff` runs one for any file whose stat changed. `.git/info/attributes` and
//      `.git/config` are read by git itself and nothing switches them off, and
//      listing the filters first then diffing leaves a gap a writer could use. So
//      `diff` never reads the repository's own configuration: it runs against a
//      throwaway git directory (see shadowDiff) that holds a copy of the index,
//      HEAD as a bare commit id, an alternates link to the real objects, a minimal
//      config of our own, and no info/attributes. No filter is defined anywhere
//      in it, so none can run, and no time window exists to race.
//
// Threat model: an attacker who can write .git/config can already add hooks or
// aliases that the user's own git runs, so this does not add exposure. What is
// covered is that nothing in .git/config, .git/info/attributes or a checked-in
// .gitattributes makes evidence loading run a program. What is not covered:
// `rev-parse` and `ls-files` still read the repository's config (their `-c`
// overrides cover the settings that execute commands), and per-repository
// core.filemode, core.symlinks and core.ignorecase are not carried over.
//
// Needs no particular git version: no `--attr-source` is used, because the private git directory above
// defines no driver for an attribute to select.

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

export const READ_ONLY = new Set(["rev-parse", "diff", "ls-files"]);

/** The id of the empty tree, which depends on the repository's hash algorithm. */
export function emptyTreeFor(objectFormat: string): string {
  return objectFormat === "sha256"
    ? "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
    : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "no-git" | "too-large" | "cancelled" | "failed"; message: string; stderr: string };

export interface GitOptions {
  signal?: AbortSignal;
  /** Output beyond this many bytes fails the command. */
  maxBytes: number;
}

/** The runner `loadChanges` uses; tests hand in a slow one. */
export type GitRunner = (cwd: string, args: readonly string[], options: GitOptions) => Promise<GitResult>;

// `-c` overrides cover the config keys that run programs on their own, for the commands that still read
// the repository's config (`rev-parse`, `ls-files`).
const GLOBAL_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "--literal-pathspecs",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "core.quotePath=false",
  "-c", "core.untrackedCache=false",
  "-c", "protocol.allow=never",
];

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LC_ALL: "C.UTF-8",
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

function exec(cwd: string, args: readonly string[], options: GitOptions, env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...GLOBAL_ARGS, ...args],
      { cwd, env: { ...gitEnv(), ...env }, maxBuffer: options.maxBytes, encoding: "utf8", signal: options.signal, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout });
        const code = (error as { code?: unknown }).code;
        const message = error instanceof Error ? error.message : String(error);
        if (code === "ENOENT") return resolve({ ok: false, reason: "no-git", message: "git is not installed on this host", stderr });
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ ok: false, reason: "too-large", message, stderr });
        if ((error as { name?: string }).name === "AbortError" || options.signal?.aborted) {
          return resolve({ ok: false, reason: "cancelled", message: "git was stopped", stderr });
        }
        resolve({ ok: false, reason: "failed", message, stderr });
      },
    );
  });
}

type Failed = Extract<GitResult, { ok: false }>;

async function revParse(cwd: string, options: GitOptions, ...args: string[]): Promise<string | Failed> {
  const r = await exec(cwd, ["rev-parse", ...args], { ...options, maxBytes: 64 * 1024 });
  return r.ok ? r.stdout.trim() : r;
}

/**
 * Run `diff` against a private git directory so the repository's own config and
 * info/attributes are never read. Returns the not-ok result of the setup step
 * (a `not a git repository` is passed to the caller as a plain run).
 */
async function shadowDiff(cwd: string, args: readonly string[], options: GitOptions): Promise<GitResult> {
  const top = await revParse(cwd, options, "--show-toplevel");
  if (typeof top !== "string") return top.reason === "failed" ? exec(cwd, args, options) : top;
  const objects = await revParse(cwd, options, "--git-path", "objects");
  const index = await revParse(cwd, options, "--git-path", "index");
  const head = await revParse(cwd, options, "--verify", "-q", "HEAD");
  const format = await revParse(cwd, options, "--show-object-format");
  if (typeof objects !== "string") return objects;
  if (typeof index !== "string") return index;
  const shadow = await mkdtemp(join(tmpdir(), "docket-git-"));
  try {
    await mkdir(join(shadow, "objects", "info"), { recursive: true });
    await mkdir(join(shadow, "refs"), { recursive: true });
    await writeFile(join(shadow, "objects", "info", "alternates"), `${resolvePath(cwd, objects)}\n`);
    await writeFile(
      join(shadow, "config"),
      format === "sha256"
        ? "[core]\n\trepositoryformatversion = 1\n\tbare = false\n[extensions]\n\tobjectformat = sha256\n"
        : "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
    );
    // An unborn HEAD is a symbolic ref to a branch that does not exist, as in the real repository.
    await writeFile(join(shadow, "HEAD"), typeof head === "string" && /^[0-9a-f]{40,64}$/.test(head) ? `${head}\n` : "ref: refs/heads/unborn\n");
    const realIndex = isAbsolute(index) ? index : resolvePath(cwd, index);
    await copyFile(realIndex, join(shadow, "index")).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e; // no index yet: diff sees an empty one
    });
    return await exec(cwd, args, options, { GIT_DIR: shadow, GIT_WORK_TREE: top });
  } finally {
    await rm(shadow, { recursive: true, force: true });
  }
}

export const runGit: GitRunner = async (cwd, args, options) => {
  const subcommand = args[0];
  if (!READ_ONLY.has(subcommand)) {
    throw new Error(`git ${subcommand} is not a read-only command the evidence reader may run`);
  }
  return subcommand === "diff" ? shadowDiff(cwd, args, options) : exec(cwd, args, options);
};
