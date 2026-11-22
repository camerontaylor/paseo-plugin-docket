import { z } from "zod";
import { blockId, viewBlocks } from "./document";
import { canComment, type SurfaceRecord } from "./record";

const changes = z.object({
  files: z.array(z.object({
    id: z.string(), path: z.string(), oldPath: z.string().optional(),
    status: z.enum(["added", "changed", "removed", "renamed"]),
    added: z.number(), removed: z.number(), patch: z.string(),
    hunks: z.array(z.object({ id: z.string(), header: z.string() })).optional(),
  })),
  notes: z.array(z.string()),
});

export function parseChanges(text: string) {
  const result = changes.safeParse(JSON.parse(text));
  if (!result.success) throw new Error("Changed files snapshot is unreadable");
  return result.data;
}

export function splitHunks(patch: string) {
  const starts = [...patch.matchAll(/^@@ /gm)].map(({ index }) => index);
  return starts.map((start, index) => patch.slice(start, starts[index + 1]));
}

export function boundReviews(record: SurfaceRecord) {
  const bindings = new Map<string, string[]>();
  if (!record.document) return bindings;
  const ids = new Set(viewBlocks(record.document).map(blockId));
  for (const question of record.document.questions ?? []) {
    if (question.kind !== "review" || !question.of || !ids.has(question.of) || !Object.hasOwn(record.questions, question.id)) continue;
    bindings.set(question.of, [...(bindings.get(question.of) ?? []), question.id]);
  }
  return bindings;
}

function unsentComments(record: SurfaceRecord) {
  return Object.entries(record.comments).filter(([, comment]) => comment.text && comment.delivery === null);
}

/** Drafts that need a standalone preview because the item editor is unavailable. */
export function retainedItemComments(record: SurfaceRecord) {
  if (canComment(record) && !record.orphanedAt) return [];
  return unsentComments(record).map(([on, { title, text, version }]) => ({ on, title, text, version }));
}

export function sendableComments(record: SurfaceRecord) {
  if (!record.document) return [];
  return unsentComments(record).map(([on, { version }]) => ({ on, version }));
}
