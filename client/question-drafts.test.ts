import { describe, expect, it } from "vitest";
import type { DraftContent } from "../shared/record";
import { applyCommand, createRecord } from "../shared/transitions";
import { draftSet } from "../shared/rpc";
import { draftWriteInput, openTargets, recommendations, sendableTargets, submittedPreview } from "./question-drafts";

const now = "2026-11-21T10:00:00.000Z";

describe("shared question controls", () => {
  it("builds a partial send with stored versions and accepts recommendations without overwriting entered answers", () => {
    const result = createRecord({
      id: "s_abc123", agentId: "agent", now,
      document: {
        v: 1, summary: "Decisions",
        questions: [
          { id: "pick", kind: "choice", prompt: "Pick two", options: ["a", "b", "c"], multi: true, min: 2, recommend: ["a", "b"] },
          { id: "name", kind: "text", prompt: "Name", recommend: "example" },
          { id: "review", kind: "review", prompt: "Review", items: [{ id: "first", title: "First" }, { id: "second", title: "Second" }], recommend: "approve" },
        ],
      },
    });
    if (!result.ok) throw new Error(result.refusal.message);
    let record = result.record;
    const drafts: [string, DraftContent][] = [
      ["pick", { value: ["c"] }],
      ["name", { note: "A note" }],
      ["review.first", { verdict: "change" }],
      ["review.second", { comment: "A comment" }],
    ];
    for (const [target, draft] of drafts) {
      const r = applyCommand(record, { kind: "setDraft", target, draft, now, baseVersion: 0 });
      if (!r.ok) throw new Error(r.refusal.message);
      record = r.record;
    }
    expect(sendableTargets(record)).toEqual([{ target: "review.first", version: 1 }]);
    expect(recommendations(record)).toEqual([
      { target: "name", content: { value: "example", note: "A note", by: "recommended" } },
      { target: "review.second", content: { verdict: "approve", comment: "A comment", by: "recommended" } },
    ]);
    const sent = applyCommand(record, { kind: "send", targets: sendableTargets(record), now });
    if (!sent.ok) throw new Error(sent.refusal.message);
    expect(openTargets(sent.record).map(({ target }) => target)).toEqual(["pick", "name", "review.second"]);
    expect(sent.record.questions.review.items?.first.state).toBe("answered");
  });
});

it("parses repeated manual draft edits against the strict RPC contract", () => {
  const created = createRecord({
    id: "s_abc123", agentId: "agent", now,
    document: {
      v: 1, summary: "Pick",
      questions: [{ id: "pick", kind: "choice", prompt: "Pick", multi: true, options: ["a", "b"] }],
    },
  });
  if (!created.ok) throw new Error(created.refusal.message);
  let record = created.record;
  for (const [baseVersion, patch] of [
    [0, { value: ["a"] }],
    [1, { value: ["a", "b"] }],
    [2, { note: "Keep this" }],
    [3, { other: "A custom choice" }],
  ] satisfies [number, DraftContent][]) {
    const manual = { ...record.drafts.pick, ...patch };
    const parsed = draftSet.input.parse(draftWriteInput(record.id, "pick", baseVersion, manual));
    expect(parsed.baseVersion).toBe(baseVersion);
    expect(parsed.draft).not.toHaveProperty("version");
    const updated = applyCommand(record, { ...parsed, kind: "setDraft", now });
    if (!updated.ok) throw new Error(updated.refusal.message);
    record = updated.record;
  }
  expect(record.drafts.pick).toEqual({
    version: 4, value: ["a", "b"], note: "Keep this", other: "A custom choice",
  });
});

it("renders submitted labels, Other, notes and item comments", () => {
  expect(submittedPreview({
    at: now, text: ["Alpha", "Beta"], value: ["a", "b"], other: "Custom", note: "Keep the note",
  })).toBe("Alpha, Beta\nOther: Custom\nNote: Keep the note");
  expect(submittedPreview({ at: now, text: ["My answer"], note: "Context" }))
    .toBe("My answer\nNote: Context");
  expect(submittedPreview({ at: now, verdict: "approve", comment: "A comment" }))
    .toBe("approve\nComment: A comment");
});
