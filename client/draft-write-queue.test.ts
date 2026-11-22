import { describe, expect, it, vi } from "vitest";
import { drainDraftWrites, type Edit } from "./draft-write-queue";
import { draftWriteInput, sendableTargets } from "./question-drafts";
import { draftSet } from "../shared/rpc";
import { applyCommand, createRecord, type Command } from "../shared/transitions";

const now = "2026-11-21T10:00:00.000Z";

function fixture() {
  const created = createRecord({
    id: "s_abc123", agentId: "agent", now,
    document: {
      v: 1, summary: "Decisions",
      view: { t: "plan", steps: [{ id: "step", title: "Step" }] },
      questions: ["first", "second", "third"].map((id) => ({ id, kind: "text", prompt: id })),
    },
  });
  if (!created.ok) throw new Error(created.refusal.message);
  let record = created.record;
  function apply(command: Command) {
    const result = applyCommand(record, command);
    if (result.ok) record = result.record;
    return result;
  }
  function write(target: string, edit: Edit) {
    return apply({ kind: "setDraft", now, ...draftSet.input.parse(draftWriteInput(record.id, target, edit.version, edit.content)) });
  }
  return { apply, write, read: () => record };
}

function localEdits() {
  return new Map<string, Edit>(["first", "second", "third"].map((target) => [
    target, { content: { value: `Local ${target}` }, version: 0 },
  ]));
}

describe("draining queued question edits", () => {
  it("drops a target answered elsewhere and saves the remaining edits for Send", async () => {
    const surface = fixture();
    expect(surface.write("first", { content: { value: "Other client" }, version: 0 }).ok).toBe(true);
    expect(surface.apply({ kind: "send", targets: [{ target: "first", version: 1 }], now }).ok).toBe(true);
    const edits = localEdits();
    const discarded = vi.fn();

    await drainDraftWrites(edits, new Map(), async (target, edit) => {
      const result = surface.write(target, edit);
      if (result.ok) return result.record.drafts[target].version;
      const { code, message } = result.refusal;
      if (code === "target-not-open") return code;
      throw new Error(message);
    }, discarded);

    expect(discarded).toHaveBeenCalledExactlyOnceWith("target-not-open");
    expect(edits.size).toBe(0);
    expect(surface.read().questions.first.answer?.text).toEqual(["Other client"]);
    const targets = sendableTargets(surface.read());
    expect(targets).toEqual([{ target: "second", version: 1 }, { target: "third", version: 1 }]);
    expect(surface.apply({ kind: "send", targets, now }).ok).toBe(true);
  });

  it("preserves failed and unattempted edits for an ordinary retry", async () => {
    const edits = localEdits();
    const acknowledged = new Map<string, number>();
    const discarded = vi.fn();
    const write = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(1);

    await expect(drainDraftWrites(edits, acknowledged, write, discarded)).rejects.toThrow("Offline");
    expect([...edits.keys()]).toEqual(["second", "third"]);
    expect(edits.get("second")?.content).toEqual({ value: "Local second" });
    expect([...acknowledged]).toEqual([["first", 1]]);
    expect(discarded).not.toHaveBeenCalled();

    await drainDraftWrites(edits, acknowledged, write, discarded);
    expect(edits.size).toBe(0);
    expect(write.mock.calls.map(([target]) => target)).toEqual(["first", "second", "second", "third"]);
  });

  it("preserves a pending item comment after another client answers the last question", async () => {
    const surface = fixture();
    for (const target of localEdits().keys()) {
      expect(surface.write(target, { content: { value: "Other client" }, version: 0 }).ok).toBe(true);
    }
    expect(surface.apply({ kind: "send", targets: sendableTargets(surface.read()), now }).ok).toBe(true);
    const edits = localEdits();
    edits.set("comment:plan.step", { content: { comment: "Keep this step" }, version: 0 });
    await drainDraftWrites(edits, new Map(), async (target, edit) => {
      if (target !== "comment:plan.step") {
        const result = surface.write(target, edit);
        if (!result.ok && result.refusal.code === "closed") return "closed";
        throw new Error("Expected the answer edit to be closed");
      }
      const result = surface.apply({
        kind: "setComment", on: "plan.step", text: edit.content?.comment ?? null, baseVersion: edit.version, now,
      });
      if (!result.ok) throw new Error(result.refusal.message);
      return result.record.comments["plan.step"].version;
    }, vi.fn());
    expect(edits.size).toBe(0);
    expect(surface.read().comments["plan.step"]).toMatchObject({ text: "Keep this step", delivery: null });
  });

  it("clears all unwriteable edits when the whole surface closes", async () => {
    const surface = fixture();
    expect(surface.apply({ kind: "close", now }).ok).toBe(true);
    const edits = localEdits();
    const write = vi.fn(async (target: string, edit: Edit) => {
      const result = surface.write(target, edit);
      if (!result.ok && result.refusal.code === "closed") return result.refusal.code;
      throw new Error("Expected the store to refuse the edit on the closed surface");
    });
    const discarded = vi.fn();
    await drainDraftWrites(edits, new Map(), write, discarded);
    expect(edits.size).toBe(0);
    expect(write).toHaveBeenCalledTimes(3);
    expect(discarded.mock.calls).toEqual([["closed"], ["closed"], ["closed"]]);
  });
});
