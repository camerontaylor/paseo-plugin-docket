import { expect, it } from "vitest";
import { boundReviews, parseChanges, retainedItemComments, sendableComments, splitHunks } from "./block-view";
import { parseMarkdown } from "./diagram/markdown";
import { parseSequence } from "./diagram/sequence";
import { parseFlowchart } from "./diagram/flowchart";
import { layoutFlowchart, layoutSequence } from "./diagram/layout";
import type { SurfaceRecord } from "./record";
import { applyCommand, createRecord, type Command } from "./transitions";

const now = "2026-11-22T12:00:00.000Z";

function makeRecord(input: Parameters<typeof createRecord>[0]) {
  const result = createRecord(input);
  if (!result.ok) throw Error(result.refusal.message);
  return result.record;
}

it("binds both nested step reviews and standalone reviews to their proper locations", () => {
  const record = makeRecord({
    id: "s_test01", agentId: "agent", now,
    document: {
      v: 1, summary: "Queue rollout", view: { t: "plan", steps: [
        { id: "table", title: "Add the jobs table", children: [{ id: "test", title: "Check test fixtures" }] },
      ] },
      questions: [
        { id: "steps", kind: "review", prompt: "Review the plan", of: "plan" },
        { id: "checks", kind: "review", prompt: "Review the snapshot", of: "plan" },
        { id: "timing", kind: "review", prompt: "Review timing", items: ["Schedule"] },
      ],
    },
  });
  expect([...boundReviews(record)]).toEqual([["plan", ["steps", "checks"]]]);
  expect(Object.keys(record.questions.steps.items!)).toEqual(["table", "test"]);
});

it("sends a display-only item comment with its title, once per draft", () => {
  const record = makeRecord({
    id: "s_test01", agentId: "agent", now,
    document: { v: 1, summary: "Plan", view: { t: "plan", steps: [{ id: "table", title: "Add the jobs table" }] } },
  });
  const draft = applyCommand(record, { kind: "setComment", on: "plan.table", text: "Keep the migration reversible", baseVersion: 0, now });
  if (!draft.ok) throw Error(draft.refusal.message);
  const comments = sendableComments(draft.record);
  expect(comments).toEqual([{ on: "plan.table", version: 1 }]);
  const sent = applyCommand(draft.record, {
    kind: "send", targets: [], comments, now: "2026-11-23T12:00:00.000Z",
  });
  if (!sent.ok) throw Error(sent.refusal.message);
  expect(sent.delivery?.text).toContain("Add the jobs table");
  expect(sent.delivery?.text).toContain("Keep the migration reversible");
  expect(sent.record.resolvedAt).toBe(now);
  expect(sendableComments(sent.record)).toEqual([]);
});

it("keeps stored file and hunk identifiers with the correct patch", () => {
  const patch = "diff --git a/queue.txt b/queue.txt\n@@ -1 +1 @@\n-old\n+new\n@@ -6 +6 @@\n-b\n+c";
  const snapshot = parseChanges(JSON.stringify({ notes: [], files: [{
    id: "f1", path: "queue.txt", status: "changed", added: 2, removed: 2, patch,
    hunks: [{ id: "f1h1", header: "@@ -1 +1 @@" }, { id: "f1h2", header: "@@ -6 +6 @@" }],
  }] }));
  expect(snapshot.files[0].hunks?.map(({ id }) => id)).toEqual(["f1h1", "f1h2"]);
  expect(splitHunks(snapshot.files[0].patch)).toEqual(["@@ -1 +1 @@\n-old\n+new\n", "@@ -6 +6 @@\n-b\n+c"]);
});

it("parses task lists, tables and fenced text, with layout for D10's two diagram kinds", () => {
  expect(parseMarkdown("# Plan\n- [x] Checked\nKey | Value\n--- | ---\nQueue | Mail\n````ts\n```\n````")).toEqual([
    { kind: "heading", level: 1, content: [{ kind: "text", text: "Plan" }] },
    { kind: "bullet", items: [[{ kind: "text", text: "☑ Checked" }]] },
    { kind: "table", rows: [
      [[{ kind: "text", text: "Key" }], [{ kind: "text", text: "Value" }]],
      [[{ kind: "text", text: "Queue" }], [{ kind: "text", text: "Mail" }]],
    ] },
    { kind: "code", language: "ts", text: "```" },
  ]);
  const flow = parseFlowchart("flowchart LR\nA[Queue] --> B[Worker]")!;
  expect(layoutFlowchart(flow).nodes).toHaveLength(2);
  const sequence = parseSequence("sequenceDiagram\nQueue->>Worker: Dispatch")!;
  expect(layoutSequence(sequence.participants, sequence.events.length).columns).toHaveLength(2);
  expect(parseFlowchart("pie\nTitle")).toBeNull();
  expect(parseSequence("pie\nTitle")).toBeNull();
});


function apply(record: SurfaceRecord, command: Command) {
  const result = applyCommand(record, command);
  if (!result.ok) throw Error(result.refusal.message);
  return result.record;
}

it.each(["close", "closeReplaced"] as const)("keeps item drafts readable and actionable after %s", (kind) => {
  const on = "plan.table";
  const record = makeRecord({
    id: "s_test01", agentId: "agent", now,
    document: {
      v: 1, summary: "Plan", questions: [{ id: "answer", kind: "text", prompt: "Review" }],
      view: { t: "plan", steps: [{ id: "table", title: "Add the jobs table" }] },
    },
  });
  const edit = { kind: "setComment", on, text: "Keep the migration reversible", baseVersion: 0, now } as const;
  const drafted = apply(record, edit);
  expect(retainedItemComments(drafted)).toEqual([]);
  const closed = apply(drafted, kind === "close" ? { kind, now } : { kind, by: "s_test02", now });
  expect(retainedItemComments(closed)).toEqual([{ on, title: "Add the jobs table", text: edit.text, version: 1 }]);

  // An edit already buffered on a client can finish against the original item.
  const saved = apply(closed, { ...edit, baseVersion: 1, text: "Use a reversible migration" });
  const stale = applyCommand(saved, { ...edit, text: null, baseVersion: 1 });
  expect(stale).toMatchObject({ ok: false, refusal: { code: "stale-draft" } });
  const cleared = apply(saved, { ...edit, text: null, baseVersion: 2 });
  expect(retainedItemComments(cleared)).toEqual([]);
  expect(sendableComments(cleared)).toEqual([]);

  const comments = sendableComments(saved);
  const answer = applyCommand(saved, { kind: "send", targets: [{ target: "answer", version: 0 }], comments, now });
  expect(answer).toMatchObject({ ok: false, refusal: { code: "closed" } });
  const sent = apply(saved, { kind: "send", targets: [], comments, now: "2026-11-23T12:00:00Z" });
  expect(sent.resolvedAt).toBe(closed.resolvedAt);
  expect(sent.deliveries[0].text).toContain("Use a reversible migration");
  expect(sent.deliveries[0].text).toContain("Add the jobs table");
  expect(sent.deliveries[0].messageId).toContain(record.id);
  expect(retainedItemComments(sent)).toEqual([]);
  expect(sendableComments(sent)).toEqual([]);

  const compacted = apply(saved, { kind: "compact", now, retentionDays: 0 });
  expect(compacted.document).toBeNull();
  expect(retainedItemComments(compacted)).toEqual(retainedItemComments(saved));
  expect(sendableComments(compacted)).toEqual([]);
  expect(applyCommand(compacted, { kind: "send", targets: [], comments, now })).toMatchObject({
    ok: false, refusal: { code: "closed" },
  });
  expect(applyCommand(compacted, { ...edit, baseVersion: 2 })).toMatchObject({ ok: false, refusal: { code: "closed" } });
  expect(retainedItemComments(apply(compacted, { ...edit, text: null, baseVersion: 2 }))).toEqual([]);
});

it("previews comments when a display-only surface is replaced or orphaned", () => {
  const on = "plan.step";
  const record = makeRecord({
    id: "s_test01", agentId: "agent", now,
    document: { v: 1, summary: "Plan", view: { t: "plan", steps: [{ id: "step", title: "Step" }] } },
  });
  const drafted = apply(record, { kind: "setComment", on, text: "Check the queue", baseVersion: 0, now });
  const replaced = apply(drafted, { kind: "closeReplaced", by: "s_test02", now });
  expect(replaced.closed).toBeNull();
  expect(retainedItemComments(replaced)).toEqual([{ on, title: "Step", text: "Check the queue", version: 1 }]);
  expect(retainedItemComments({ ...drafted, orphanedAt: now })).toEqual(retainedItemComments(replaced));
});
