import { describe, expect, it } from "vitest";
import type { DraftContent } from "../shared/record";
import { applyCommand, createRecord } from "../shared/transitions";
import { openTargets, recommendations, sendableTargets } from "./question-drafts";

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
