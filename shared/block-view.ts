import { z } from "zod";
import { blockId, viewBlocks } from "./document";
import type { SurfaceRecord } from "./record";

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

export function sendableComments(record: SurfaceRecord) {
  return Object.entries(record.comments).flatMap(([on, comment]) =>
    comment.text && comment.delivery === null ? [{ on, version: comment.version }] : [],
  );
}
