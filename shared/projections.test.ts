import { describe, expect, it } from "vitest";
import { type SurfaceDocument } from "./document";
import { allDecisionsDeleted, decisionsOf, searchDecisions, summaryOf } from "./projections";
import { type SurfaceRecord } from "./record";
import { type Command, applyCommand, createRecord } from "./transitions";

const DOC: SurfaceDocument = {
  v: 1,
  summary: "Mailer rollout",
  context: "moving off cron",
  questions: [
    { id: "queue", kind: "choice", prompt: "Which queue?", label: "Queue", options: ["pg_boss", { id: "bullmq", label: "BullMQ" }] },
    { id: "chk", kind: "review", prompt: "Check", items: [{ id: "a", title: "Add the table" }, { id: "b", title: "Drop cron" }, "third"] },
  ],
};

function build(id = "s_one", agentId = "ag1", at = "2026-11-01T00:00:00.000Z"): SurfaceRecord {
  const made = createRecord({ id, agentId, workspaceId: "w1", now: at, document: DOC });
  if (!made.ok) throw new Error("create");
  return made.record;
}
const run = (r: SurfaceRecord, c: Command): SurfaceRecord => {
  const x = applyCommand(r, c);
  if (!x.ok) throw new Error(JSON.stringify(x.refusal));
  return x.record;
};
const answer = (r: SurfaceRecord, at: string, note = "cheaper to run"): SurfaceRecord => {
  let x = run(r, { kind: "setDraft", target: "queue", draft: { value: "bullmq", note }, baseVersion: 0, now: at });
  x = run(x, { kind: "setDraft", target: "chk.a", draft: { verdict: "approve" }, baseVersion: 0, now: at });
  x = run(x, { kind: "setDraft", target: "chk.b", draft: { verdict: "change", comment: "keep cron a week" }, baseVersion: 0, now: at });
  return run(x, {
    kind: "send",
    targets: [{ target: "queue", version: 1 }, { target: "chk.a", version: 1 }, { target: "chk.b", version: 1 }],
    skip: ["chk"],
    now: at,
  });
};

describe("summaryOf", () => {
  it("counts open questions and pending deliveries", () => {
    const r = build();
    expect(summaryOf(r)).toMatchObject({ id: "s_one", status: "open", openQuestions: 2, pendingDeliveries: 0, compacted: false });
    const s = summaryOf(answer(r, "2026-11-02T00:00:00.000Z"));
    expect(s).toMatchObject({ status: "resolved", openQuestions: 0, pendingDeliveries: 1, resolvedAt: "2026-11-02T00:00:00.000Z" });
  });

  it("reports an archived surface with open questions as orphaned", () => {
    expect(summaryOf(run(build(), { kind: "holdOnArchive", now: "2026-11-02T00:00:00.000Z" })).status).toBe("orphaned");
  });

  it("counts retryable removed deliveries and excludes redacted ones", () => {
    const now = "2026-11-02T00:00:00.000Z";
    let r = run(build(), { kind: "setDraft", target: "queue", draft: { value: "bullmq" }, baseVersion: 0, now });
    r = run(r, { kind: "send", targets: [{ target: "queue", version: 1 }], now });
    r = run(r, { kind: "updateDelivery", n: 1, to: "removed", now });
    expect(summaryOf(r).pendingDeliveries).toBe(1);
    r = run(r, { kind: "deleteDecisions", questions: ["queue"], now });
    expect(summaryOf(r)).toMatchObject({ openQuestions: 1, pendingDeliveries: 0 });
  });
});

describe("decisions", () => {
  it("lists answered questions, with each item's title, and leaves out skipped ones", () => {
    const r = answer(build(), "2026-11-02T00:00:00.000Z");
    const d = decisionsOf(r);
    expect(d.map((x) => x.questionId)).toEqual(["queue", "chk"]);
    expect(d[0]).toMatchObject({ label: "Queue", delivery: 1, deliveryState: "queued", at: "2026-11-02T00:00:00.000Z" });
    expect(d[0].answer?.text).toEqual(["BullMQ"]);
    expect(d[1].items?.map((i) => [i.id, i.title, i.answer.verdict])).toEqual([["a", "Add the table", "approve"], ["b", "Drop cron", "change"]]);
  });

  it("is empty for an open or skipped surface", () => {
    expect(decisionsOf(build())).toEqual([]);
    const skipped = run(build(), { kind: "send", targets: [], skip: ["queue", "chk"], now: "2026-11-02T00:00:00.000Z" });
    expect(decisionsOf(skipped)).toEqual([]);
  });

  it("finds a decision by words in its note, its item titles and comments, after compaction", () => {
    const r = answer(build(), "2026-11-02T00:00:00.000Z");
    const compacted = run(r, { kind: "compact", now: "2026-12-30T00:00:00.000Z" });
    expect(compacted.document).toBeNull();
    const all = decisionsOf(compacted);
    expect(searchDecisions(all, { text: "CHEAPER run" }).map((d) => d.questionId)).toEqual(["queue"]);
    expect(searchDecisions(all, { text: "drop cron" }).map((d) => d.questionId)).toEqual(["chk"]);
    expect(searchDecisions(all, { text: "cron week" }).map((d) => d.questionId)).toEqual(["chk"]);
    expect(searchDecisions(all, { text: "bullmq mailer" }).map((d) => d.questionId)).toEqual(["queue", "chk"].slice(0, 1));
    expect(searchDecisions(all, { text: "redis" })).toEqual([]);
  });

  it("filters by agent, workspace and time, sorts newest first and limits", () => {
    const a = answer(build("s_a", "ag1"), "2026-11-02T00:00:00.000Z");
    const b = answer(build("s_b", "ag2"), "2026-11-05T00:00:00.000Z");
    const all = [...decisionsOf(a), ...decisionsOf(b)];
    expect(searchDecisions(all).map((d) => d.surfaceId)).toEqual(["s_b", "s_b", "s_a", "s_a"]);
    expect(searchDecisions(all, { agentId: "ag1" }).every((d) => d.surfaceId === "s_a")).toBe(true);
    expect(searchDecisions(all, { workspaceId: "nope" })).toEqual([]);
    expect(searchDecisions(all, { since: "2026-11-03T00:00:00.000Z" }).every((d) => d.surfaceId === "s_b")).toBe(true);
    expect(searchDecisions(all, { until: "2026-11-05T00:00:00.000Z" }).every((d) => d.surfaceId === "s_a")).toBe(true);
    expect(searchDecisions(all, { limit: 1 })).toHaveLength(1);
  });

  it("drops deleted decisions, and says when nothing is left", () => {
    const r = run(answer(build(), "2026-11-02T00:00:00.000Z"), { kind: "updateDelivery", n: 1, to: "delivered", now: "2026-11-02T00:00:00.000Z" });
    expect(allDecisionsDeleted(r)).toBe(false);
    const one = run(r, { kind: "deleteDecisions", questions: ["queue"], now: "2026-11-03T00:00:00.000Z" });
    expect(decisionsOf(one).map((d) => d.questionId)).toEqual(["chk"]);
    expect(allDecisionsDeleted(one)).toBe(false);
    const all = run(one, { kind: "deleteDecisions", now: "2026-11-03T00:00:00.000Z" });
    expect(decisionsOf(all)).toEqual([]);
    expect(allDecisionsDeleted(all)).toBe(true);
    expect(allDecisionsDeleted(build())).toBe(false);
  });
});
