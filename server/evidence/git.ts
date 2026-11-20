// Git, read only (spec 27.3). Three safeguards, because a repository's own
// configuration can make git run programs:
//   1. only the subcommands in READ_ONLY are ever run;
//   2. the environment is rebuilt, with the user and system config ignored,
//      no pager, no optional locks (so `diff` does not rewrite the index), no
//      terminal prompts, and literal pathspecs (no `:(…)` magic);
//   3. `-c` overrides turn off the repository-config hooks that execute
//      commands (fsmonitor, hooks path, pager), and every diff is run with
//      --no-ext-diff and --no-textconv at the call site.

import { execFile } from "node:child_process";

export const READ_ONLY = new Set(["rev-parse", "diff", "ls-files"]);

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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

// `--attr-source` with the empty tree: no checked-in `.gitattributes` applies, so a cloned repository
// cannot name a `filter`, `textconv` or `diff` driver for us to run. (`.git/info/attributes` and
// `.git/config` are local to the machine, not shipped by a clone; the `-c` overrides below still
// cover the config keys that run programs on their own.)
const GLOBAL_ARGS = [
  `--attr-source=${EMPTY_TREE}`,
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

export const runGit: GitRunner = (cwd, args, options) => {
  const subcommand = args[0];
  if (!READ_ONLY.has(subcommand)) {
    throw new Error(`git ${subcommand} is not a read-only command the evidence reader may run`);
  }
  return new Promise((resolve) => {
    execFile(
      "git",
      [...GLOBAL_ARGS, ...args],
      { cwd, env: gitEnv(), maxBuffer: options.maxBytes, encoding: "utf8", signal: options.signal, windowsHide: true },
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
};
