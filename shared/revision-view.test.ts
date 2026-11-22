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

it("follows paths, renames, and hunk headers when positional IDs move", () => {
  const document: SurfaceDocument = { v: 1, summary: "Diff", view: { t: "changes", id: "diff" } };
  const earlier = make(document);
  earlier.comments["diff.f1"] = { version: 1, text: "Keep for a", delivery: null };
  earlier.comments["diff.f2h1"] = { version: 1, text: "Keep for b's hunk", delivery: null };
  const current = make({ ...document, revises: earlier.id }, earlier);
  const files = (...rows: [string, string, string?][]) => new Map([["diff", JSON.stringify({
    files: rows.map(([id, path, oldPath]) => ({
      id, path, oldPath, status: oldPath ? "renamed" : "changed", added: 1, removed: 0,
      patch: "@@ same\n+content", hunks: [{ id: `${id}h1`, header: "@@ same" }],
    })),
    notes: [],
  })]]);
  const before = files(["f1", "a.ts"], ["f2", "b.ts"], ["f3", "d.ts"]);
  const after = files(["f1", "b.ts"], ["f2", "c.ts"], ["f3", "e.ts", "d.ts"]);
  const result = revisionView(current, earlier, after, before)!;
  expect(result.current.get("diff.f1")?.mark).toBe("Unchanged");
  expect(result.current.get("diff.f1")?.earlier?.draftComment).toBeUndefined();
  expect(result.current.get("diff.f1h1")?.earlier?.draftComment).toBe("Keep for b's hunk");
  expect(result.current.get("diff.f2")?.mark).toBe("New");
  expect(result.current.get("diff.f3")).toMatchObject({ mark: "Changed", earlier: { title: "d.ts" } });
  expect(result.removed).toMatchObject([
    { title: "a.ts", mark: "Removed", earlier: { draftComment: "Keep for a" } },
    { title: "a.ts @@ same", mark: "Removed" },
  ]);
});

it("keeps one-sided rename evidence uncertain in either direction", () => {
  const document: SurfaceDocument = { v: 1, summary: "Diff", view: { t: "changes", id: "diff" } };
  const extra = { changeItems: { diff: [{ id: "f1", title: "new.ts" }] } };
  const earlier = make(document, undefined, extra);
  const current = make({ ...document, revises: earlier.id }, earlier, extra);
  const evidence = new Map([["diff", JSON.stringify({
    files: [{ id: "f1", path: "new.ts", oldPath: "old.ts", status: "renamed", added: 0, removed: 0, patch: "rename" }],
    notes: [],
  })]]);
  for (const [left, right] of [[empty, evidence], [evidence, empty]]) {
    const result = revisionView(current, earlier, left, right)!;
    expect(result.incomplete).toBe(true);
    expect(result.current.get("diff.f1")?.mark).toBeUndefined();
    expect(result.removed[0].mark).toBeUndefined();
  }
});

it("keeps comparison incomplete when either referenced excerpt lacks a hash", () => {
  const document: SurfaceDocument = {
    v: 1, summary: "Refs", view: { t: "plan", id: "plan", steps: [
      { id: "step", title: "Plan", files: ["README.md"], detail: "See `src/a.ts:2`" },
    ] },
    questions: [{ id: "review", kind: "review", prompt: "Review", items: [
      { id: "item", title: "Item", ref: "src/a.ts:2" },
    ] }],
  };
  const earlier = make(document);
  const snapshots = { excerpt: { ref: "src/a.ts:2", hash: "fingerprint", readAt: now, bytes: 5 } };
  const current = make({ ...document, revises: earlier.id }, earlier, { snapshots });
  for (const address of ["plan.step", reviewAddress("review", "item")]) {
    for (const [next, old] of [[{ ...current, snapshots: {} }, earlier], [current, earlier],
      [{ ...current, snapshots: {} }, { ...earlier, snapshots }]]) {
      expect(revisionView(next, old, empty, empty)?.current.get(address)?.mark).toBeUndefined();
      expect(revisionView(next, old, empty, empty)?.incomplete).toBe(true);
    }
    expect(revisionView(current, { ...earlier, snapshots }, empty, empty)?.current.get(address)?.mark).toBe("Unchanged");
  }
});

it("withholds feedback when both snapshots load but only one corroborates the destination", () => {
  const document: SurfaceDocument = { v: 1, summary: "Diff", view: { t: "changes", id: "diff" } };
  const earlier = make(document);
  earlier.comments["diff.f1"] = { version: 1, text: "Earlier destination feedback", delivery: null };
  const current = make({ ...document, revises: earlier.id }, earlier);
  const evidence = (oldPath?: string) => new Map([["diff", JSON.stringify({
    files: [
      { id: "f1", path: "new.ts", oldPath, status: oldPath ? "renamed" : "changed", added: 0, removed: 0, patch: "metadata" },
      { id: "f2", path: "sibling.ts", status: "changed", added: 1, removed: 0, patch: "sibling patch" },
    ], notes: [],
  })]]);
  for (const [next, prior] of [[evidence("old.ts"), evidence()], [evidence(), evidence("old.ts")]]) {
    const view = revisionView(current, earlier, next, prior)!;
    expect(view.incomplete).toBe(true);
    expect(view.current.get("diff.f1")?.mark).toBeUndefined();
    expect(view.current.get("diff.f1")?.earlier).toBeUndefined();
    expect(view.current.get("diff.f2")?.mark).toBe("Unchanged");
    expect(view.removed[0].mark).toBeUndefined();
    expect(view.removed[0].earlier?.draftComment).toBe("Earlier destination feedback");
  }
});

it("claims each corroborated rename even when a sibling reuses an old path", () => {
  const document: SurfaceDocument = { v: 1, summary: "Diff", view: { t: "changes", id: "diff" } };
  const earlier = make(document);
  earlier.comments["diff.f1"] = { version: 1, text: "Earlier a", delivery: null };
  earlier.comments["diff.f2"] = { version: 1, text: "Earlier b", delivery: null };
  const current = make({ ...document, revises: earlier.id }, earlier);
  const evidence = (rows: [string, string?][]) => new Map([["diff", JSON.stringify({
    files: rows.map(([path, oldPath], index) => ({
      id: `f${index + 1}`, path, oldPath, status: oldPath ? "renamed" : "changed", added: 0, removed: 0, patch: "metadata",
    })), notes: [],
  })]]);
  const view = revisionView(current, earlier, evidence([["a.ts", "b.ts"], ["c.ts", "a.ts"]]), evidence([["a.ts"], ["b.ts"]]))!;
  expect(view.current.get("diff.f1")?.earlier?.draftComment).toBe("Earlier b");
  expect(view.current.get("diff.f2")?.earlier?.draftComment).toBe("Earlier a");
  expect([...view.current.values()].map(({ mark }) => mark)).toEqual(["Changed", "Changed"]);
  expect(view.removed).toEqual([]);
  expect(view.incomplete).toBe(false);
});

it("preserves shifted hunk feedback separately when the header no longer identifies it", () => {
  const document: SurfaceDocument = { v: 1, summary: "Diff", view: { t: "changes", id: "diff" } };
  const earlier = make(document);
  earlier.comments["diff.f1h1"] = { version: 1, text: "Earlier hunk feedback", delivery: null };
  const current = make({ ...document, revises: earlier.id }, earlier);
  const evidence = (line: number) => {
    const header = `@@ -${line},1 +${line},1 @@`;
    return new Map([["diff", JSON.stringify({
      files: [{ id: "f1", path: "a.ts", status: "changed", added: 1, removed: 1,
        patch: `${header}\n-old\n+new`, hunks: [{ id: "f1h1", header }] }], notes: [],
    })]]);
  };
  const view = revisionView(current, earlier, evidence(11), evidence(10))!;
  expect(view.current.get("diff.f1h1")?.earlier).toBeUndefined();
  expect(view.removed).toMatchObject([{ mark: "Removed", earlier: { draftComment: "Earlier hunk feedback" } }]);
});
