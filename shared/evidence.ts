// Evidence, the pure part (spec 7.7, 26, 27.3, 27.4): how a `code` excerpt or a
// `ref` is cut from a file, how git's machine-readable output becomes the
// `changes` items `f1`, `f1h1`, the limits, and the comparison that says a
// snapshot has "changed since". Reading files, running git and hashing are
// in server/evidence/.

import type { Block, SurfaceDocument } from "./document";
import { viewBlocks } from "./document";
import { utf8Bytes } from "./ids";
import { LIMITS } from "./limits";
import type { ChangeFile } from "./text";

export type EvidenceLimits = Pick<
  typeof LIMITS,
  "loadedFileBytes" | "evidenceBytes" | "changesFiles" | "excerptLines" | "refContextLines"
>;

/** What the store keeps beside the evidence file `evidence/<surfaceId>/<n>` (spec 26). */
export interface SnapshotMeta {
  kind: "file" | "changes";
  /** File snapshots: the path as the agent wrote it. */
  path?: string;
  /** File snapshots: the first and last line shown. */
  from?: number;
  to?: number;
  /** `changes` snapshots: what was asked for. */
  of?: string;
  paths?: string[];
  /** HEAD (or the commit shown) when the work tree is under git. */
  commit?: string;
  /** Hash of the stored content, `sha256:<hex>`. */
  hash: string;
  /** File snapshots: hash of the whole file as read. "Changed since" compares this one. */
  fileHash?: string;
  readAt: string;
  /** Bytes of the stored content. */
  bytes: number;
  /** The block or reference this snapshot belongs to. */
  block?: string;
  ref?: string;
}

// --- paths ------------------------------------------------------------------

/** Why a path cannot be read at all, judged on its text alone; null when it can be tried. */
export function pathSyntaxProblem(path: string): string | null {
  if (typeof path !== "string" || path === "") return "the path is empty";
  if (path.indexOf("\0") >= 0) return "the path contains a NUL byte";
  if (path.split(/[\\/]/).some((part) => part === "..")) {
    return "the path has a `..` segment; write the path from the workspace root without it";
  }
  return null;
}

/** A `changes.paths` entry: relative, inside the work tree, no `..`. */
export function changesPathProblem(path: string): string | null {
  const syntax = pathSyntaxProblem(path);
  if (syntax) return syntax;
  if (path.charAt(0) === "/" || path.charAt(0) === "\\" || /^[A-Za-z]:[\\/]/.test(path)) {
    return "the path is absolute; `paths` are relative to the agent's workspace";
  }
  return null;
}

// --- excerpts -----------------------------------------------------------------

/** Lines of a text as a reader counts them: a final line break does not start a line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.charAt(l.length - 1) === "\r" ? l.slice(0, -1) : l));
}

export interface Excerpt {
  text: string;
  from: number;
  to: number;
  totalLines: number;
}
export type ExcerptResult = ({ ok: true } & Excerpt) | { ok: false; message: string };

function cut(lines: string[], from: number, to: number): ExcerptResult {
  const total = lines.length;
  if (total === 0) return { ok: true, text: "", from: 1, to: 0, totalLines: 0 };
  if (from > total) return { ok: false, message: `the file has ${total} line${total === 1 ? "" : "s"}, so line ${from} is past its end` };
  const last = Math.min(to, total);
  return { ok: true, text: lines.slice(from - 1, last).join("\n"), from, to: last, totalLines: total };
}

/** A `code` block's lines: `from`..`to`, else the first `excerptLines` from `from` (default 1). */
export function codeExcerpt(
  text: string,
  from: number | undefined,
  to: number | undefined,
  limits: Pick<EvidenceLimits, "excerptLines"> = LIMITS,
): ExcerptResult {
  const start = from ?? 1;
  return cut(splitLines(text), start, to ?? start + limits.excerptLines - 1);
}

/** `path:line` or `path:from-to`; null when it is not one. */
export function parseRef(ref: string): { path: string; from: number; to: number } | null {
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(ref);
  if (!m) return null;
  const from = Number(m[2]);
  const to = m[3] === undefined ? from : Number(m[3]);
  if (from < 1 || to < from) return null;
  return { path: m[1], from, to };
}

/** A `ref`'s lines: a range as written (at most `excerptLines`), or a line with context each side. */
export function refExcerpt(
  text: string,
  from: number,
  to: number,
  limits: Pick<EvidenceLimits, "excerptLines" | "refContextLines"> = LIMITS,
): ExcerptResult {
  const lines = splitLines(text);
  if (from === to) return cut(lines, Math.max(1, from - limits.refContextLines), from + limits.refContextLines);
  return cut(lines, from, Math.min(to, from + limits.excerptLines - 1));
}

// --- refs in a document ---------------------------------------------------------

export interface FoundRef {
  /** Where it was written, as a pointer into the document. */
  at: string;
  ref: string;
  /** Inline-code refs in prose: a miss is a warning, not a refusal. */
  lenient: boolean;
}

const INLINE_CODE = /`([^`\n]+)`/g;

/** `path:line` or `path:from-to` spans in inline code (spec 27.3). */
export function refsInMarkdown(text: string): string[] {
  const found: string[] = [];
  INLINE_CODE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE.exec(text)) !== null) {
    const span = m[1];
    const parsed = parseRef(span);
    if (!parsed || span.length > LIMITS.refLength) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(span) || (!/[./]/.test(parsed.path))) continue;
    found.push(span);
  }
  return found;
}

/** Every `ref` and `path:line` the document points at, in reading order, each ref once. */
export function collectRefs(doc: SurfaceDocument): FoundRef[] {
  const out: FoundRef[] = [];
  const seen = new Set<string>();
  const add = (at: string, ref: string, lenient: boolean): void => {
    if (seen.has(ref)) return;
    seen.add(ref);
    out.push({ at, ref, lenient });
  };
  const prose = (at: string, text: unknown): void => {
    if (typeof text === "string") for (const r of refsInMarkdown(text)) add(at, r, true);
  };
  const strict = (at: string, ref: unknown): void => {
    if (typeof ref === "string" && parseRef(ref)) add(at, ref, false);
  };
  prose("/context", doc.context);
  viewBlocks(doc).forEach((block: Block, i) => {
    const at = Array.isArray(doc.view) ? `/view/${i}` : "/view";
    if (typeof block === "string") return prose(at, block);
    if (block.t !== "plan") return;
    const walk = (steps: typeof block.steps, base: string): void => {
      steps.forEach((step, j) => {
        const p = `${base}/${j}`;
        strict(p + "/ref", step.ref);
        const files = typeof step.files === "string" ? [step.files] : (step.files ?? []);
        files.forEach((f) => strict(p + "/files", f));
        prose(p + "/detail", step.detail);
        if (step.children) walk(step.children, p + "/children");
      });
    };
    walk(block.steps, at + "/steps");
  });
  (doc.questions ?? []).forEach((q, i) => {
    if (q.kind !== "review") return;
    (q.items ?? []).forEach((item, j) => {
      if (typeof item === "string") return;
      const p = `/questions/${i}/items/${j}`;
      strict(p + "/ref", item.ref);
      prose(p + "/detail", item.detail);
    });
  });
  return out;
}

// --- limits ---------------------------------------------------------------------

/** A reason when one loaded file or diff is over the per-item limit. */
export function itemSizeProblem(what: string, bytes: number, limits: Pick<EvidenceLimits, "loadedFileBytes"> = LIMITS): string | null {
  if (bytes <= limits.loadedFileBytes) return null;
  return `${what} is ${bytes} bytes, over the ${limits.loadedFileBytes}-byte (${mib(limits.loadedFileBytes)}) limit for one loaded file`;
}

/** A reason when adding `adding` bytes would take one surface's evidence over its limit. */
export function evidenceBudgetProblem(used: number, adding: number, limits: Pick<EvidenceLimits, "evidenceBytes"> = LIMITS): string | null {
  if (used + adding <= limits.evidenceBytes) return null;
  return `the evidence for one surface is limited to ${limits.evidenceBytes} bytes (${mib(limits.evidenceBytes)}); loading this would make it ${used + adding}`;
}

function mib(bytes: number): string {
  const n = bytes / (1024 * 1024);
  return `${Number.isInteger(n) ? n : n.toFixed(1)} MiB`;
}

/** Bytes of stored content, counted as UTF-8. */
export function contentBytes(text: string): number {
  return utf8Bytes(text);
}

// --- changed since --------------------------------------------------------------

export type EvidenceStatus = "same" | "changed" | "gone";

/** `current` is the hash of the thing now, or null when it cannot be read any more. */
export function compareHash(snapshot: string, current: string | null): EvidenceStatus {
  if (current === null) return "gone";
  return snapshot === current ? "same" : "changed";
}

// --- git output ---------------------------------------------------------------------

export type ChangeStatus = ChangeFile["status"];

export interface RawChange {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  added: number;
  removed: number;
  binary?: boolean;
}

function tokens(out: string): string[] {
  const parts = out.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** `git diff --name-status -z`: `M\0path\0`, and `R100\0old\0new\0` for a rename. */
export function parseNameStatusZ(out: string): Pick<RawChange, "path" | "status" | "oldPath">[] {
  const parts = tokens(out);
  const list: Pick<RawChange, "path" | "status" | "oldPath">[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++].charAt(0);
    if (code === "R" || code === "C") {
      const oldPath = parts[i++];
      const path = parts[i++];
      if (path === undefined) break;
      list.push({ path, oldPath, status: code === "R" ? "renamed" : "added" });
    } else {
      const path = parts[i++];
      if (path === undefined) break;
      list.push({ path, status: code === "A" ? "added" : code === "D" ? "removed" : "changed" });
    }
  }
  return list;
}

/** `git diff --numstat -z`: `12\t4\tpath\0`, `-\t-\tpath\0` for binary, `1\t0\t\0old\0new\0` for a rename. */
export function parseNumstatZ(out: string): { path: string; added: number; removed: number; binary: boolean }[] {
  const parts = tokens(out);
  const list: { path: string; added: number; removed: number; binary: boolean }[] = [];
  for (let i = 0; i < parts.length; ) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i++]);
    if (!m) continue;
    let path = m[3];
    if (path === "") {
      i++; // the old path
      path = parts[i++];
      if (path === undefined) break;
    }
    const binary = m[1] === "-";
    list.push({ path, added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary });
  }
  return list;
}

/** Joins `--name-status` and `--numstat` of the same diff; null when they do not describe the same files. */
export function joinChanges(nameStatus: string, numstat: string): RawChange[] | null {
  const statuses = parseNameStatusZ(nameStatus);
  const counts = parseNumstatZ(numstat);
  if (statuses.length !== counts.length) return null;
  const out: RawChange[] = [];
  for (let i = 0; i < statuses.length; i++) {
    if (statuses[i].path !== counts[i].path) return null;
    out.push({ ...statuses[i], added: counts[i].added, removed: counts[i].removed, binary: counts[i].binary });
  }
  return out;
}

/** The per-file pieces of a patch, in order; each starts with `diff --git `. */
export function splitPatch(patch: string): string[] {
  if (patch === "") return [];
  const pieces: string[] = [];
  let start = -1;
  let pos = 0;
  while (pos <= patch.length) {
    if (patch.startsWith("diff --git ", pos)) {
      if (start >= 0) pieces.push(patch.slice(start, pos));
      start = pos;
    }
    const nl = patch.indexOf("\n", pos);
    if (nl < 0) break;
    pos = nl + 1;
  }
  if (start >= 0) pieces.push(patch.slice(start));
  return pieces;
}

/** The `@@ -a,b +c,d @@ …` lines of one file's patch. Body lines start with space, `+`, `-` or `\`, so no body line can match. */
export function hunkHeaders(piece: string): string[] {
  const out: string[] = [];
  for (const line of piece.split("\n")) if (line.startsWith("@@ ")) out.push(line.replace(/\r$/, ""));
  return out;
}

/** The patch of a new file git does not know yet (untracked), as `git diff` would print it. */
export function addedFilePatch(path: string, text: string, executable: boolean): string {
  const head = `diff --git a/${path} b/${path}\nnew file mode ${executable ? "100755" : "100644"}\n`;
  const lines = splitLines(text);
  if (lines.length === 0) return head;
  const noEol = text.charAt(text.length - 1) !== "\n";
  const body = lines.map((l) => "+" + l).join("\n") + "\n" + (noEol ? "\\ No newline at end of file\n" : "");
  return `${head}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}`;
}

export interface ChangeEntry extends RawChange {
  /** Hunk header lines, in order. */
  hunks: string[];
}

export interface BuiltChanges<E extends ChangeEntry = ChangeEntry> {
  files: ChangeFile[];
  /** Entries in the same order as `files`, so a caller can attach what it holds per file. */
  entries: E[];
  omitted: number;
  notes: string[];
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Display order, then at most `changesFiles` files (spec 27.4: "cut short with a note beyond that"). */
export function capChanges<E extends { path: string }>(
  entries: E[],
  limits: Pick<EvidenceLimits, "changesFiles"> = LIMITS,
): { kept: E[]; omitted: number; notes: string[] } {
  const sorted = entries.slice().sort(byPath);
  const kept = sorted.slice(0, limits.changesFiles);
  const omitted = sorted.length - kept.length;
  const notes = omitted > 0 ? [`${omitted} more changed file${omitted === 1 ? "" : "s"} not shown: the limit is ${limits.changesFiles}; narrow with \`paths\``] : [];
  return { kept, omitted, notes };
}

/** Gives ids: `f1`, `f2`, … in display order and `f1h1`, `f1h2`, … for their hunks (spec 27.3). */
export function buildChanges<E extends ChangeEntry>(entries: E[], limits: Pick<EvidenceLimits, "changesFiles"> = LIMITS): BuiltChanges<E> {
  const { kept, omitted, notes } = capChanges(entries, limits);
  const files: ChangeFile[] = kept.map((entry, i) => {
    const id = `f${i + 1}`;
    const file: ChangeFile = { id, path: entry.path, status: entry.status, added: entry.added, removed: entry.removed };
    if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
    file.hunks = entry.hunks.map((header, j) => ({ id: `${id}h${j + 1}`, header }));
    return file;
  });
  return { files, entries: kept, omitted, notes };
}
