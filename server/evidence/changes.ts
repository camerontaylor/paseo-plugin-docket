// A `changes` block: the files changed in the work tree, a commit or a range,
// read by read-only git commands in the agent's working directory (spec 27.3).
// The result is the display model (ids `f1`, `f1h1`) and the content to keep
// as the snapshot: the patch, file by file.

import { lstat } from "node:fs/promises";
import {
  type ChangeEntry,
  type EvidenceLimits,
  addedFilePatch,
  buildChanges,
  capChanges,
  changesPathProblem,
  hunkHeaders,
  itemSizeProblem,
  joinChanges,
  splitLines,
  splitPatch,
  type RawChange,
} from "../../shared/evidence";
import { LIMITS } from "../../shared/limits";
import type { ChangeFile } from "../../shared/text";
import { type FileReader, sha256 } from "./confine";
import { emptyTreeFor, type GitRunner } from "./git";

export type ChangesFailure = "not-git" | "no-git" | "git-failed" | "bad-input" | "unknown-commit" | "too-large" | "timeout";

export type ChangesResult =
  | {
      ok: true;
      files: ChangeFile[];
      /** The snapshot content: JSON with each file's patch. */
      content: string;
      hash: string;
      commit?: string;
      notes: string[];
    }
  | { ok: false; reason: ChangesFailure; message: string };

export interface ChangesContext {
  cwd: string;
  signal?: AbortSignal;
  limits?: Pick<EvidenceLimits, "loadedFileBytes" | "changesFiles">;
  git: GitRunner;
  readFile: FileReader;
}

const DIFF = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=dirty", "-M", "--relative", "--src-prefix=a/", "--dst-prefix=b/"];

function fail(reason: ChangesFailure, message: string): ChangesResult {
  return { ok: false, reason, message };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

export async function loadChanges(input: { of?: string; paths?: string[] }, ctx: ChangesContext): Promise<ChangesResult> {
  const limits = ctx.limits ?? LIMITS;
  const cap = limits.loadedFileBytes + 1;
  const of = input.of ?? "worktree";
  const paths = input.paths ?? [];
  const run = (args: string[], maxBytes = cap) => ctx.git(ctx.cwd, args, { signal: ctx.signal, maxBytes });

  for (const p of paths) {
    const problem = changesPathProblem(p);
    if (problem) return fail("bad-input", `\`paths\` entry ${JSON.stringify(p)}: ${problem}`);
  }
  if (of.startsWith("-")) return fail("bad-input", `\`of\` ${JSON.stringify(of)} must not start with "-"`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(of)) return fail("bad-input", `\`of\` ${JSON.stringify(of)} has a control character`);

  const probe = await run(["rev-parse", "--is-inside-work-tree"], 1024);
  if (!probe.ok) {
    if (probe.reason === "no-git") return fail("no-git", probe.message);
    if (probe.reason === "cancelled") return fail("timeout", "git was stopped when the time for loading ran out");
    if (/not a git repository/i.test(probe.stderr)) return fail("not-git", notGit(ctx.cwd));
    return fail("git-failed", firstLine(probe.stderr) || probe.message);
  }
  if (probe.stdout.trim() !== "true") return fail("not-git", notGit(ctx.cwd));

  const verify = async (rev: string): Promise<string | null | undefined> => {
    if (rev.startsWith("-")) return null;
    const r = await run(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], 1024);
    if (r.ok) return r.stdout.trim();
    if (r.reason === "cancelled") return undefined;
    return null;
  };

  // What to compare, and which commit the snapshot is "of".
  let diffTargets: string[];
  const format = await run(["rev-parse", "--show-object-format"], 1024);
  const EMPTY_TREE = emptyTreeFor(format.ok ? format.stdout.trim() : "sha1");
  let commit: string | undefined;
  let worktree = false;
  if (of === "worktree") {
    worktree = true;
    const head = await verify("HEAD");
    if (head === undefined) return fail("timeout", "git was stopped when the time for loading ran out");
    commit = head ?? undefined;
    diffTargets = [head ?? EMPTY_TREE];
  } else if (of.includes("..")) {
    const three = of.includes("...");
    const [a, b, ...rest] = of.split(three ? "..." : "..");
    if (!a || !b || rest.length > 0) return fail("bad-input", `\`of\` ${JSON.stringify(of)} is not a range: write "base..head"`);
    const [base, head] = [await verify(a), await verify(b)];
    if (base === undefined || head === undefined) return fail("timeout", "git was stopped when the time for loading ran out");
    if (!base) return fail("unknown-commit", `\`of\`: ${JSON.stringify(a)} is not a commit in this repository`);
    if (!head) return fail("unknown-commit", `\`of\`: ${JSON.stringify(b)} is not a commit in this repository`);
    commit = head;
    diffTargets = three ? [`${base}...${head}`] : [base, head];
  } else {
    const sha = await verify(of);
    if (sha === undefined) return fail("timeout", "git was stopped when the time for loading ran out");
    if (!sha) return fail("unknown-commit", `\`of\`: ${JSON.stringify(of)} is not a commit in this repository`);
    commit = sha;
    const parent = await run(["rev-parse", "--verify", "--quiet", `${sha}^1`], 1024);
    diffTargets = [parent.ok ? parent.stdout.trim() : EMPTY_TREE, sha];
  }

  const spec = (list: string[]): string[] => (list.length > 0 ? ["--", ...list] : []);
  const ran = async (extra: string[], list: string[], max = cap) => run([...DIFF, ...extra, ...diffTargets, ...spec(list)], max);

  const nameStatus = await ran(["--name-status", "-z"], paths);
  if (!nameStatus.ok) return gitFailure(nameStatus);
  const numstat = await ran(["--numstat", "-z"], paths);
  if (!numstat.ok) return gitFailure(numstat);
  const tracked = joinChanges(nameStatus.stdout, numstat.stdout);
  if (!tracked) return fail("git-failed", "git listed the changed files two different ways");

  type Held = ChangeEntry & { patch: string; tracked: boolean };
  const all: (RawChange & { tracked: boolean })[] = tracked.map((t) => ({ ...t, tracked: true }));

  if (worktree) {
    const others = await run(["ls-files", "--others", "--exclude-standard", "-z", ...spec(paths)]);
    if (!others.ok) return gitFailure(others);
    for (const p of others.stdout.split("\0")) {
      if (p === "" || p.endsWith("/")) continue; // a nested repository or submodule, not a file
      all.push({ path: p, status: "added", added: 0, removed: 0, tracked: false });
    }
  }

  const { kept, notes } = capChanges(all, limits);
  const held: Held[] = kept.map((e) => ({ ...e, hunks: [], patch: "" }));
  const notesOut = [...notes];

  // Tracked files: one patch for the kept ones; its pieces follow the same order as the list.
  let patchBytes = 0;
  const keptTracked = held.filter((h) => h.tracked);
  if (keptTracked.length > 0) {
    const order = tracked.filter((t) => keptTracked.some((h) => h.path === t.path));
    const specs = order.flatMap((t) => (t.oldPath ? [t.oldPath, t.path] : [t.path]));
    const patch = await ran(["-U3"], specs);
    if (!patch.ok) return gitFailure(patch, "the diff is over the size limit; narrow it with `paths`");
    // A file that changes kind (regular file to link) comes out as two sections under one name, so
    // sections are matched to files by their `diff --git` header, never by position.
    const byHeader = new Map<string, Held>();
    for (const t of order) {
      const h = keptTracked.find((k) => k.path === t.path)!;
      byHeader.set(`diff --git a/${t.oldPath ?? t.path} b/${t.path}`, h);
    }
    let unmatched = 0;
    for (const piece of splitPatch(patch.stdout)) {
      const h = byHeader.get(piece.slice(0, piece.indexOf("\n") < 0 ? piece.length : piece.indexOf("\n")));
      if (!h) {
        unmatched++;
        continue;
      }
      h.patch += piece;
      h.hunks = [...h.hunks, ...hunkHeaders(piece)];
    }
    if (unmatched > 0) notesOut.push(`${unmatched} section${unmatched === 1 ? "" : "s"} of the diff could not be matched to a file, so ${unmatched === 1 ? "it is" : "they are"} not shown`);
    let heldBytes = 0;
    for (const h of keptTracked) heldBytes += h.patch.length;
    patchBytes += heldBytes;
    if (patchBytes > limits.loadedFileBytes) return fail("too-large", `${itemSizeProblem("the diff", patchBytes, limits)}; narrow it with \`paths\``);
  }

  // Untracked files are new to git: shown as added, read like any other file but never through a link.
  for (const h of held.filter((x) => !x.tracked)) {
    const info = await lstat(`${ctx.cwd}/${h.path}`).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      notesOut.push(`${h.path}: a symbolic link, shown without its content`);
      continue;
    }
    if (!info.isFile()) continue;
    const read = await ctx.readFile(h.path, { cwd: ctx.cwd, roots: [ctx.cwd], maxBytes: limits.loadedFileBytes, signal: ctx.signal });
    if (!read.ok) {
      if (read.reason === "too-large") return fail("too-large", `${h.path}: ${read.message}; narrow \`changes\` with \`paths\``);
      notesOut.push(`${h.path}: ${read.message}; shown without its content`);
      continue;
    }
    h.patch = addedFilePatch(h.path, read.text, (info.mode & 0o111) !== 0);
    h.added = splitLines(read.text).length;
    h.hunks = hunkHeaders(h.patch);
    // Stop as soon as the snapshot cannot fit, instead of holding hundreds of MiB first.
    patchBytes += h.patch.length;
    const over = itemSizeProblem("the diff", patchBytes, limits);
    if (over) return fail("too-large", `${over}; narrow it with \`paths\``);
  }

  const built = buildChanges(held, limits);
  const content = JSON.stringify({
    of,
    commit,
    files: built.files.map((f, i) => ({ ...f, patch: built.entries[i].patch })),
    notes: notesOut,
  });
  const size = itemSizeProblem("the diff", Buffer.byteLength(content), limits);
  if (size) return fail("too-large", `${size}; narrow it with \`paths\``);
  return { ok: true, files: built.files, content, hash: sha256(content), commit, notes: notesOut };
}

function notGit(cwd: string): string {
  return `a \`changes\` block reads git, and ${cwd} is not inside a git repository; show the diff as a \`code\` block with \`diff: true\`, or run the agent in a repository`;
}

function gitFailure(r: { ok: false; reason: string; message: string; stderr: string }, tooLarge?: string): ChangesResult {
  if (r.reason === "too-large") return fail("too-large", tooLarge ?? "git's output is over the size limit; narrow it with `paths`");
  if (r.reason === "cancelled") return fail("timeout", "git was stopped when the time for loading ran out");
  if (r.reason === "no-git") return fail("no-git", r.message);
  return fail("git-failed", firstLine(r.stderr) || r.message);
}
