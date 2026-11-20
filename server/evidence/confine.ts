// Reading one file for evidence, confined (spec 7.7, 28.3). The shape follows
// genui's `readConfinedFile` (Apache-2.0, see NOTICE): resolve the root and the
// target through links before comparing, refuse anything that lands outside,
// and open the resolved path with O_NOFOLLOW. Added here: the path's text is
// judged before the disk is touched, a FIFO cannot hang the read, and the
// resolved path is checked again after the open so a link swapped in between
// is caught.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { pathSyntaxProblem } from "../../shared/evidence";

export type ReadFailure =
  | "syntax" // the path's text cannot be read as a path
  | "outside" // not inside a permitted folder, or a link leads out of one
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

export const readConfinedText: FileReader = async (requested, options) => {
  const syntax = pathSyntaxProblem(requested);
  if (syntax) return failure("syntax", syntax);

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
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) return failure("not-file", "not a regular file");
    if (info.size > options.maxBytes) {
      return failure("too-large", `${info.size} bytes is over the ${options.maxBytes}-byte limit for one loaded file`);
    }
    // A parent directory swapped for a link between the check and the open lands elsewhere.
    let again: string;
    try {
      again = await realpath(absolute);
    } catch {
      return failure("outside", OUTSIDE);
    }
    if (again !== real) return failure("outside", OUTSIDE);

    const buffer = Buffer.allocUnsafe(Math.min(options.maxBytes, info.size) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      if (options.signal?.aborted) return failure("error", "reading was cancelled");
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > options.maxBytes) {
      return failure("too-large", `the file grew past the ${options.maxBytes}-byte limit while it was read`);
    }
    const bytes = buffer.subarray(0, filled);
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
