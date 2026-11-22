import { makeDeadline, TIMED_OUT } from "./deadline";
// Everything `show` reads for one document (spec 7.7): the file behind each
// `code` block, each `ref`, and each `changes` block, as snapshots with a
// hash, the commit and a size. All of it shares one deadline (plan S3): when
// the time is up the call is refused with the reason, so a tool call never
// nears the host's ten-minute hold.
//
// Nothing here writes. `writeEvidence` (store.ts) puts the contents on disk,
// and the caller writes the surface record only after that.

import {
  type EvidenceLimits,
  type SnapshotMeta,
  codeExcerpt,
  collectRefs,
  contentBytes,
  evidenceBudgetProblem,
  parseRef,
  refExcerpt,
} from "../../shared/evidence";
import { blockId, viewBlocks, type SurfaceDocument } from "../../shared/document";
import { LIMITS } from "../../shared/limits";
import type { RenderContext } from "../../shared/text";
import { loadChanges } from "./changes";
import { type FileReader, readConfinedText, sha256 } from "./confine";
import { type GitRunner, runGit } from "./git";

export type LoadFailure =
  | "timeout"
  | "outside"
  | "missing"
  | "too-large"
  | "evidence-too-large"
  | "not-git"
  | "no-git"
  | "git-failed"
  | "unreadable"
  | "unknown-commit"
  | "bad-input";

export interface LoadProblem {
  /** A pointer into the document. */
  pointer: string;
  reason: LoadFailure;
  message: string;
}

export interface LoadedEvidence {
  /** Snapshot number (as a string, "1", "2", …) to its record. */
  snapshots: Record<string, SnapshotMeta>;
  /** Snapshot number to the content to keep in `evidence/<surfaceId>/<n>`. */
  contents: Record<string, string>;
  /** What the text and view forms show: excerpts and changed files by block id. */
  render: RenderContext;
  /** Block id to snapshot number. */
  byBlock: Record<string, string>;
  /** `ref` text to snapshot number. */
  byRef: Record<string, string>;
  warnings: string[];
}

export type LoadResult =
  | { ok: true; evidence: LoadedEvidence }
  | { ok: false; reason: LoadFailure; message: string; problems: LoadProblem[] };

export interface LoadOptions {
  /** The agent's working directory. */
  cwd: string;
  /** Folders a file may be read from besides `cwd` (the agent's storage, /tmp, folders the user added). */
  extraRoots?: readonly string[];
  budgetMs?: number;
  limits?: Partial<typeof LIMITS>;
  now?: () => Date;
  readFile?: FileReader;
  git?: GitRunner;
}

export async function loadEvidence(doc: SurfaceDocument, options: LoadOptions): Promise<LoadResult> {
  const limits = { ...LIMITS, ...options.limits };
  const budgetMs = options.budgetMs ?? limits.evidenceBudgetMs;
  const readFile = options.readFile ?? readConfinedText;
  const git = options.git ?? runGit;
  const now = options.now ?? (() => new Date());
  const roots = [options.cwd, ...(options.extraRoots ?? [])];
  const deadline = makeDeadline(budgetMs);

  const evidence: LoadedEvidence = { snapshots: {}, contents: {}, render: {}, byBlock: {}, byRef: {}, warnings: [] };
  const problems: LoadProblem[] = [];
  let used = 0;
  let next = 1;
  const timeout = (): LoadResult => ({
    ok: false,
    reason: "timeout",
    message: `loading files and git for this surface took more than ${budgetMs / 1000} seconds and was stopped; show fewer or smaller files, or narrow \`changes\` with \`paths\``,
    problems: [{ pointer: "", reason: "timeout", message: `over the ${budgetMs / 1000}-second limit for loading` }],
  });

  const add = (meta: SnapshotMeta, content: string, pointer: string): string | null => {
    const budget = evidenceBudgetProblem(used, meta.bytes, limits);
    if (budget) {
      problems.push({ pointer, reason: "evidence-too-large", message: budget });
      return null;
    }
    used += meta.bytes;
    const n = String(next++);
    evidence.snapshots[n] = meta;
    evidence.contents[n] = content;
    return n;
  };

  try {
    // HEAD for file snapshots, best effort: a work tree not under git has none.
    const head = await deadline.guard(headOf(git, options.cwd, deadline.signal));
    if (head === TIMED_OUT) return timeout();
    const commit = head ?? undefined;

    const read = async (path: string, signal: AbortSignal) => readFile(path, { cwd: options.cwd, roots, maxBytes: limits.loadedFileBytes, signal });

    const blocks = viewBlocks(doc);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (typeof block === "string" || block.t === "plan") continue;
      const at = Array.isArray(doc.view) ? `/view/${i}` : "/view";
      const id = blockId(block)!;
      if (block.t === "code") {
        if (block.file === undefined) continue;
        const r = await deadline.guard(read(block.file, deadline.signal));
        if (r === TIMED_OUT) return timeout();
        if (!r.ok) {
          problems.push({ pointer: at + "/file", reason: failureOf(r.reason), message: `\`file\` ${JSON.stringify(block.file)}: ${r.message}` });
          continue;
        }
        const ex = codeExcerpt(r.text, block.from, block.to, limits);
        if (!ex.ok) {
          problems.push({ pointer: at + "/from", reason: "bad-input", message: `\`file\` ${JSON.stringify(block.file)}: ${ex.message}` });
          continue;
        }
        const meta: SnapshotMeta = {
          kind: "file",
          path: block.file,
          from: ex.from,
          to: ex.to,
          hash: sha256(ex.text),
          fileHash: r.hash,
          readAt: now().toISOString(),
          bytes: contentBytes(ex.text),
          block: id,
        };
        if (commit) meta.commit = commit;
        const n = add(meta, ex.text, at);
        if (n) {
          evidence.byBlock[id] = n;
          (evidence.render.code ??= {})[id] = ex.text;
        }
      } else {
        const r = await deadline.guard(
          loadChanges({ of: block.of, paths: block.paths }, { cwd: options.cwd, signal: deadline.signal, limits, git, readFile }),
        );
        if (r === TIMED_OUT) return timeout();
        if (!r.ok) {
          if (r.reason === "timeout") return timeout();
          problems.push({ pointer: at, reason: r.reason, message: r.message });
          continue;
        }
        const meta: SnapshotMeta = {
          kind: "changes",
          of: block.of ?? "worktree",
          hash: r.hash,
          readAt: now().toISOString(),
          bytes: contentBytes(r.content),
          block: id,
        };
        if (block.paths) meta.paths = block.paths;
        if (r.commit) meta.commit = r.commit;
        const n = add(meta, r.content, at);
        if (n) {
          evidence.byBlock[id] = n;
          (evidence.render.changes ??= {})[id] = r.files;
          for (const note of r.notes) evidence.warnings.push(`${id}: ${note}`);
        }
      }
    }

    for (const found of collectRefs(doc)) {
      const parsed = parseRef(found.ref);
      if (!parsed) continue;
      const r = await deadline.guard(read(parsed.path, deadline.signal));
      if (r === TIMED_OUT) return timeout();
      if (!r.ok) {
        const message = `\`ref\` ${JSON.stringify(found.ref)}: ${r.message}`;
        // A missing file may be one the plan will create; prose that merely looks like a ref never refuses.
        if (r.reason === "missing" || found.lenient) evidence.warnings.push(`${found.at}: ${message}; no excerpt kept`);
        else problems.push({ pointer: found.at, reason: failureOf(r.reason), message });
        continue;
      }
      const ex = refExcerpt(r.text, parsed.from, parsed.to, limits);
      if (!ex.ok) {
        evidence.warnings.push(`${found.at}: \`ref\` ${JSON.stringify(found.ref)}: ${ex.message}; no excerpt kept`);
        continue;
      }
      const meta: SnapshotMeta = {
        kind: "file",
        path: parsed.path,
        from: ex.from,
        to: ex.to,
        hash: sha256(ex.text),
        fileHash: r.hash,
        readAt: now().toISOString(),
        bytes: contentBytes(ex.text),
        ref: found.ref,
      };
      if (commit) meta.commit = commit;
      const n = add(meta, ex.text, found.at);
      if (n) evidence.byRef[found.ref] = n;
    }
  } finally {
    deadline.stop();
  }

  if (problems.length > 0) {
    const first = problems[0];
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
    return { ok: false, reason: first.reason, message: `${first.message}${more}`, problems };
  }
  return { ok: true, evidence };
}

function failureOf(reason: string): LoadFailure {
  switch (reason) {
    case "outside":
    case "missing":
    case "too-large":
      return reason;
    case "syntax":
      return "bad-input";
    default:
      return "unreadable";
  }
}

async function headOf(git: GitRunner, cwd: string, signal: AbortSignal): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { signal, maxBytes: 1024 });
  return r.ok ? r.stdout.trim() || null : null;
}

