// Snapshots on disk and the "changed since" check (spec 26, 7.7).
//
//   <dataDir>/evidence/<surfaceId>/<n>     the content, mode 0600, directories 0700
//
// The caller writes the evidence first and the surface record after it, so a
// record never names a snapshot that is not there. A crash in between leaves
// unreferenced files, which `removeEvidence` clears.

import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isSurfaceId } from "../../shared/ids";
import { type EvidenceStatus, type SnapshotMeta, compareHash } from "../../shared/evidence";
import { LIMITS } from "../../shared/limits";
import { loadChanges } from "./changes";
import { type FileReader, readConfinedText } from "./confine";
import { type GitRunner, runGit } from "./git";

function evidenceDir(dataDir: string, surfaceId: string): string {
  if (!isSurfaceId(surfaceId)) throw new Error(`not a surface id: ${surfaceId}`);
  return path.join(dataDir, "evidence", surfaceId);
}

function snapshotFile(dir: string, n: string): string {
  if (!/^[1-9][0-9]{0,5}$/.test(n)) throw new Error(`not a snapshot number: ${n}`);
  return path.join(dir, n);
}

/** Writes every snapshot's content, each to a temporary file renamed into place. */
export async function writeEvidence(dataDir: string, surfaceId: string, contents: Record<string, string>): Promise<void> {
  const dir = evidenceDir(dataDir, surfaceId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [n, content] of Object.entries(contents)) {
    const final = snapshotFile(dir, n);
    const temp = `${final}.tmp`;
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, final);
  }
}

/** The content of one snapshot (`evidence.get`), or null when it is not kept. */
export async function readEvidence(dataDir: string, surfaceId: string, n: string): Promise<string | null> {
  try {
    return await readFile(snapshotFile(evidenceDir(dataDir, surfaceId), n), "utf8");
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT") return null;
    throw cause;
  }
}

/** Clears a surface's evidence, after a failed `show` or at compaction. */
export async function removeEvidence(dataDir: string, surfaceId: string): Promise<void> {
  await rm(evidenceDir(dataDir, surfaceId), { recursive: true, force: true });
}

export interface StatusOptions {
  cwd: string;
  extraRoots?: readonly string[];
  signal?: AbortSignal;
  limits?: Partial<typeof LIMITS>;
  readFile?: FileReader;
  git?: GitRunner;
}

export interface SnapshotStatus {
  status: EvidenceStatus;
  /** Why the thing cannot be read any more, when it cannot. */
  detail?: string;
}

/**
 * Whether what a snapshot shows is still what is there: the whole file's hash
 * for a file, and for `changes` the hash of the same request read again. The
 * snapshot itself is never altered; the card shows it, and says so when this
 * returns "changed" or "gone".
 */
export async function snapshotStatus(meta: SnapshotMeta, options: StatusOptions): Promise<SnapshotStatus> {
  const limits = { ...LIMITS, ...options.limits };
  const readFileFn = options.readFile ?? readConfinedText;
  const git = options.git ?? runGit;
  if (meta.kind === "file") {
    if (meta.path === undefined || meta.fileHash === undefined) return { status: "gone", detail: "the snapshot does not say which file it came from" };
    const r = await readFileFn(meta.path, {
      cwd: options.cwd,
      roots: [options.cwd, ...(options.extraRoots ?? [])],
      maxBytes: limits.loadedFileBytes,
      signal: options.signal,
    });
    return r.ok ? { status: compareHash(meta.fileHash, r.hash) } : { status: compareHash(meta.fileHash, null), detail: r.message };
  }
  const r = await loadChanges({ of: meta.of, paths: meta.paths }, { cwd: options.cwd, signal: options.signal, limits, git, readFile: readFileFn });
  return r.ok ? { status: compareHash(meta.hash, r.hash) } : { status: compareHash(meta.hash, null), detail: r.message };
}

