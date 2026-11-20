// Reading one file for evidence, confined (spec 7.7, 28.3). The shape follows
// genui's `readConfinedFile` (Apache-2.0, see NOTICE): resolve the root and the
// target through links before comparing, refuse anything that lands outside,
// and open the resolved path with O_NOFOLLOW. Added here: the path's text is
// judged before the disk is touched, a FIFO cannot hang the read, and the
// resolved path is checked again after the open so a link swapped in between
// is caught (by asking the kernel where the opened descriptor lives).

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { pathSyntaxProblem } from "../../shared/evidence";

export type ReadFailure =
  | "syntax" // the path's text cannot be read as a path
  | "outside" // not inside a permitted folder, or a link leads out of one
  | "unverifiable" // opened-file verification is unavailable
  | "missing"
  | "not-file"
  | "too-large"
  | "binary"
  | "error";

export type ReadResult =
  | {
      ok: true;
      text: string;
      bytes: number;
      /** `sha256:<hex>` of the bytes read. */
      hash: string;
      realPath: string;
    }
  | { ok: false; reason: ReadFailure; message: string };

export interface ReadOptions {
  /** Relative paths are read from here. */
  cwd: string;
  /** Folders a file may be read from; the workspace first. */
  roots: readonly string[];
  maxBytes: number;
  signal?: AbortSignal;
  /** Test seams: run between the path check and the open, and just after the open. */
  hooks?: { beforeOpen?: () => void | Promise<void>; afterOpen?: () => void | Promise<void> };
}

/** The reader `show` uses; tests hand in a slow one. */
export type FileReader = (requested: string, options: ReadOptions) => Promise<ReadResult>;

export function sha256(data: Uint8Array | string): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

export function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

const OUTSIDE = "only files in the agent's workspace (and the folders it may read) can be shown; links that lead out of them are not followed";

function failure(reason: ReadFailure, message: string): ReadResult {
  return { ok: false, reason, message };
}

function code(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code: unknown }).code) : undefined;
}

/** Verify the kernel's path for the opened descriptor before reading any bytes. */
async function descriptorInside(handle: FileHandle, realRoots: readonly string[]): Promise<boolean | undefined> {
  try {
    const actual = await readlink("/proc/self/fd/" + handle.fd);
    if (path.isAbsolute(actual)) return realRoots.some((root) => inside(root, actual));
  } catch {
    // The host may lack procfs or deny access to descriptor paths.
  }
}

export const readConfinedText: FileReader = async (requested, options) => {
  const syntax = pathSyntaxProblem(requested);
  if (syntax) return failure("syntax", syntax);
  if (process.platform !== "linux") return failure("unverifiable", "file evidence requires Linux with accessible /proc/self/fd");

  const absolute = path.isAbsolute(requested) ? path.normalize(requested) : path.resolve(options.cwd, requested);

  const realRoots: string[] = [];
  for (const root of options.roots) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      /* a folder that does not exist permits nothing */
    }
  }
  // Before touching the disk: the path as written must lie under a folder, as written or resolved.
  const candidates = [...options.roots.map((r) => path.resolve(r)), ...realRoots];
  if (!candidates.some((root) => inside(root, absolute))) return failure("outside", OUTSIDE);

  let real: string;
  try {
    real = await realpath(absolute);
  } catch (cause) {
    const c = code(cause);
    if (c === "ENOENT" || c === "ENOTDIR") return failure("missing", "file not found");
    return failure("error", cause instanceof Error ? cause.message : String(cause));
  }
  if (!realRoots.some((root) => inside(root, real))) return failure("outside", OUTSIDE);

  let handle;
  try {
    // O_NONBLOCK: a FIFO would otherwise block the open until a writer appears.
    await options.hooks?.beforeOpen?.();
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    await options.hooks?.afterOpen?.();
    // O_NOFOLLOW only guards the last component: a parent directory swapped for a link after the
    // check would land elsewhere. So ask the kernel where the descriptor we hold really is.
    const verified = await descriptorInside(handle, realRoots);
    if (verified === undefined) return failure("unverifiable", "cannot verify the opened file through /proc/self/fd");
    if (!verified) return failure("outside", OUTSIDE);
    const info = await handle.stat();
    if (!info.isFile()) return failure("not-file", "not a regular file");
    if (info.size > options.maxBytes) {
      return failure("too-large", `${info.size} bytes is over the ${options.maxBytes}-byte limit for one loaded file`);
    }
    // Read to end of file or one byte past the limit, whatever the size was when we looked: a file
    // that grows while it is read must not come back silently cut.
    const chunks: Buffer[] = [];
    let filled = 0;
    while (filled <= options.maxBytes) {
      if (options.signal?.aborted) return failure("error", "reading was cancelled");
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, options.maxBytes + 1 - filled));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, filled);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      filled += bytesRead;
    }
    if (filled > options.maxBytes) {
      return failure("too-large", `the file grew past the ${options.maxBytes}-byte limit while it was read`);
    }
    const bytes = Buffer.concat(chunks, filled);
    if (bytes.subarray(0, 8000).includes(0)) return failure("binary", "not a text file");
    return { ok: true, text: bytes.toString("utf8"), bytes: filled, hash: sha256(bytes), realPath: real };
  } catch (cause) {
    const c = code(cause);
    if (c === "ELOOP") return failure("outside", OUTSIDE);
    if (c === "ENOENT") return failure("missing", "file not found");
    return failure("error", cause instanceof Error ? cause.message : String(cause));
  } finally {
    await handle?.close().catch(() => undefined);
  }
};
