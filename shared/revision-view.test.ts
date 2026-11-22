import { expect, it } from "vitest";
import type { SurfaceDocument } from "./document";
import { revisionView, reviewAddress } from "./revision-view";
import type { SurfaceRecord } from "./record";
import { applyCommand, createRecord } from "./transitions";

const now = "2026-11-21T10:00:00.000Z";
const empty = new Map<string, string>();
const doc: SurfaceDocument = {
  v: 1, summary: "Plan",
  view: { t: "plan", id: "plan", steps: [
    { id: "same", title: "Same" },
    { id: "edit", title: "Edit", children: [{ id: "gone", title: "Removed step" }] },
  ] },
  questions: [{ kind: "review", id: "check", of: "plan", prompt: "Review the steps" }],
};

function make(document: SurfaceDocument, revised?: SurfaceRecord, extra?: Partial<Parameters<typeof createRecord>[0]>) {
  const result = createRecord({
    id: revised ? "s_bbbbbb" : "s_aaaaaa", document, agentId: "agent", now, revised, ...extra,
  });
  if (!result.ok) throw new Error(result.refusal.message);
  return result.record;
}

it("matches bound feedback by block and item and keeps removed decisions separate from fresh controls", () => {
  let earlier = make(doc);
  const run = (command: Parameters<typeof applyCommand>[1]) => {
    const result = applyCommand(earlier, command);
    if (!result.ok) throw new Error(result.refusal.message);
    earlier = result.record;
  };
  run({ kind: "setDraft", target: "check.gone", draft: { verdict: "approve", comment: "Earlier verdict" }, baseVersion: 0, now });
  run({ kind: "setComment", on: "plan.gone", text: "Sent", baseVersion: 0, now });
  run({ kind: "send", targets: [{ target: "check.gone", version: 1 }], comments: [{ on: "plan.gone", version: 1 }], now });
  run({ kind: "setComment", on: "plan.gone", text: "Still drafting", baseVersion: 1, now });
  run({ kind: "setDraft", target: "check.edit", draft: { comment: "Review draft" }, baseVersion: 0, now });
  const current = make({
    ...doc, revises: earlier.id,
    questions: [{ kind: "review", id: "different", of: "plan", prompt: "Review the revised steps" }],
    view: { t: "plan", id: "plan", steps: [
      { id: "same", title: "Same" }, { id: "edit", title: "Edited" }, { id: "added", title: "Added" },
    ] },
  }, earlier);
  const view = revisionView(current, earlier, empty, empty)!;
  expect([...view.current.values()].map(({ mark }) => mark)).toEqual(["Unchanged", "Changed", "New"]);
  expect(view.current.get("plan.edit")?.earlier?.feedback[0].draft?.comment).toBe("Review draft");
  expect(view.removed).toMatchObject([{
    title: "Removed step", mark: "Removed",
    earlier: { comment: "Sent", draftComment: "Still drafting", feedback: [{ answer: { verdict: "approve", comment: "Earlier verdict" } }] },
  }]);
  expect(current.drafts).toEqual({});
  expect(current.comments).toEqual({});
  expect(Object.values(current.questions.different.items!).every(({ state }) => state === "open")).toBe(true);
  expect(revisionView(current, { ...earlier, agentId: "foreign" }, empty, empty)).toBeNull();
});

it("compares frozen files and hunks independently, and avoids claiming equality without evidence", () => {
  const changes: SurfaceDocument = { v: 1, summary: "Diff", view: { t: "changes", id: "diff" } };
  const changeItems = { diff: [{ id: "f1", title: "a" }, { id: "f1h1", title: "a @@ first" }, { id: "f2", title: "b" }] };
  const earlier = make(changes, undefined, { changeItems });
  const current = make({ ...changes, revises: earlier.id }, earlier, { changeItems });
  const frozen = (text: string) => new Map([["diff", JSON.stringify({
    files: [
      { id: "f1", path: "a", status: "changed", added: 1, removed: 0, patch: `@@ first\n+${text}`, hunks: [{ id: "f1h1", header: "@@ first" }] },
      { id: "f2", path: "b", status: "added", added: 1, removed: 0, patch: "@@ first\n+Same" },
    ], notes: [],
  })]]);
  expect([...revisionView(current, earlier, frozen("new"), frozen("old"))!.current.values()].map(({ mark }) => mark))
    .toEqual(["Changed", "Changed", "Unchanged"]);
  expect(revisionView(current, earlier, frozen("new"), empty)?.incomplete).toBe(true);
});

it("uses question scope for standalone items and keeps legacy compacted answers readable", () => {
  const review: SurfaceDocument = {
    ...doc, questions: [{ kind: "review", id: "plan", prompt: "Standalone", items: [{ id: "same", title: "Standalone" }] }],
  };
  const earlier = make(review);
  const current = make({ ...review, revises: earlier.id }, earlier);
  const view = revisionView(current, earlier, empty, empty)!;
  expect(view.current.get(reviewAddress("plan", "same"))?.title).toBe("Standalone");
  expect(view.current.get("plan.same")?.title).toBe("Same");
  earlier.questions.plan.items!.same.answer = { at: now, verdict: "approve" };
  const compacted = revisionView(current, { ...earlier, document: null, snapshots: {}, blockItems: {} }, empty, empty)!;
  expect(compacted.incomplete).toBe(true);
  expect(compacted.removed).toMatchObject([{ title: "Standalone", earlier: { feedback: [{ answer: { verdict: "approve" } }] } }]);
});
