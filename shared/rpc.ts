import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { isSurfaceId } from "./ids";
import type { Decision, Summary } from "./projections";
import { isRecordV1, type CommentRecord, type Delivery, type Draft, type SurfaceRecord } from "./record";
import type { Conflict, Refusal } from "./transitions";

const hostId = z.string().min(1);
const surfaceId = z.string().refine(isSurfaceId);
const surface = z.object({ surfaceId });
const version = z.int().nonnegative();
const empty = z.object({});
const summaryBase = z.object({
  id: surfaceId,
  rev: version,
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  summary: z.string(),
  status: z.enum(["open", "resolved", "orphaned"]),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  openQuestions: version,
  pendingDeliveries: version,
  replacedBy: z.string().nullable(),
  revises: z.string().nullable(),
  compacted: z.boolean(),
});
const summary = z.custom<Summary>((value) => summaryBase.safeParse(value).success);
const draft = z.strictObject({
  value: z.union([z.string(), z.array(z.string())]).optional(),
  other: z.string().optional(),
  note: z.string().optional(),
  verdict: z.string().optional(),
  comment: z.string().optional(),
  skipped: z.boolean().optional(),
  by: z.literal("recommended").optional(),
});
const refusal = z.object({ refusal: z.custom<Refusal>() });
const saved = z.union([
  z.object({ version }),
  z.object({ conflict: z.custom<Draft | CommentRecord>().nullable() }),
  refusal,
]);

function rpc<I extends z.ZodType, O extends z.ZodType>(name: string, input: I, result: O) {
  return defineRpc({ name, input, output: z.object({ hostId, result }) });
}

const snapshot = z.object({ hostId, kind: z.literal("snapshot"), summaries: z.array(summary) });
export const surfaces = defineSubscription({
  name: "surfaces",
  input: empty,
  event: z.discriminatedUnion("kind", [
    snapshot,
    z.object({ hostId, kind: z.literal("change"), surfaceId, rev: version, summary: summary.nullable(), removed: z.boolean().optional() }),
  ]),
});
export type SurfaceEvent = z.output<typeof surfaces.event>;

/** Snapshot used while the stream is unavailable. */
export const surfacesList = rpc("surfaces.list", empty, snapshot.shape.summaries);
export const surfaceGet = rpc("surface.get", surface, z.custom<SurfaceRecord>(isRecordV1).nullable());
export const evidenceGet = rpc("evidence.get", surface.extend({ snapshotId: z.string().regex(/^[1-9][0-9]{0,5}$/) }), z.string().nullable());
export const draftSet = rpc("draft.set", surface.extend({ target: z.string(), draft: draft.nullable(), baseVersion: version }), saved);
export const commentSet = rpc("comment.set", surface.extend({ on: z.string(), text: z.string().nullable(), baseVersion: version }), saved);
export const send = rpc("send", surface.extend({
  targets: z.array(z.object({ target: z.string(), version })),
  comments: z.array(z.object({ on: z.string(), version })).optional(),
  skip: z.array(z.string()).optional(),
}), z.union([
  z.object({ delivery: z.custom<Delivery>().nullable() }),
  z.object({ conflict: z.array(z.custom<Conflict>()) }),
  z.object({ closed: z.literal(true) }),
  refusal,
]));
const completed = z.union([refusal, z.strictObject({})]);
export const deliveryRetry = rpc("delivery.retry", surface.extend({ n: z.int().positive() }), completed);
export const decisionsSearch = rpc("decisions.search", z.object({
  query: z.string().optional(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  limit: z.int().nonnegative().optional(),
}), z.array(z.custom<Decision>()));
export const decisionsDelete = rpc("decisions.delete", z.union([
  z.strictObject({ surfaceId, questionId: z.string() }),
  z.strictObject({ agentId: z.string().min(1) }),
]), completed);
