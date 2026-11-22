import { expect, it } from "vitest";
import { boundReviews, parseChanges, sendableComments, splitHunks } from "./block-view";
import { parseMarkdown } from "./diagram/markdown";
import { parseSequence } from "./diagram/sequence";
import { parseFlowchart } from "./diagram/flowchart";
import { layoutFlowchart, layoutSequence } from "./diagram/layout";
import { applyCommand, createRecord } from "./transitions";

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
  const sent = applyCommand(draft.record, { kind: "send", targets: [], comments, now });
  if (!sent.ok) throw Error(sent.refusal.message);
  expect(sent.delivery?.text).toContain("Add the jobs table");
  expect(sent.delivery?.text).toContain("Keep the migration reversible");
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
