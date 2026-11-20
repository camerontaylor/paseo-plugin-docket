import { describe, expect, it } from "vitest";
import { type SurfaceDocument } from "./document";
import { LIMITS } from "./limits";
import { type SurfaceRecord, surfaceStatus } from "./record";
import { type Command, type Result, applyCommand, createRecord, parseTarget } from "./transitions";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T10:05:00.000Z";

const THREE: SurfaceDocument = {
  v: 1,
  summary: "Three questions",
  context: "Before the work starts",
  questions: [
    { id: "queue", kind: "choice", prompt: "Which queue?", label: "Queue", options: ["pg_boss", { id: "bullmq", label: "BullMQ" }], recommend: "pg_boss" },
    { id: "name", kind: "text", prompt: "Name it?" },
    { id: "tags", kind: "choice", prompt: "Tags?", multi: true, min: 1, max: 2, options: ["a", "b", "c"] },
  ],
};

const REVIEW: SurfaceDocument = {
  v: 1,
  summary: "Review four items",
  questions: [{ id: "chk", kind: "review", prompt: "Check", items: ["one", "two", { id: "x3", title: "three", detail: "d" }, "four"], recommend: "approve" }],
  view: [{ t: "plan", steps: [{ id: "s1", title: "Step 1", children: [{ id: "s1a", title: "Nested" }] }, { id: "s2", title: "Step 2" }] }],
};

const PLAN_REVIEW: SurfaceDocument = {
  v: 1,
  summary: "Plan review",
  questions: [{ id: "steps", kind: "review", prompt: "Steps", of: "plan", verdicts: ["do", "drop"] }],
  view: [{ t: "plan", steps: [{ id: "s1", title: "Step 1", children: [{ id: "s1a", title: "Nested" }] }, { id: "s2", title: "Step 2" }] }],
};

function make(doc: SurfaceDocument, extra: Partial<Parameters<typeof createRecord>[0]> = {}): SurfaceRecord {
  const r = createRecord({ id: "s_aaaaaa", agentId: "ag1", now: T0, document: doc, ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  return r.record;
}

function run(record: SurfaceRecord, cmd: Command): SurfaceRecord {
  const r = applyCommand(record, cmd);
  if (!r.ok) throw new Error(`${cmd.kind}: ${JSON.stringify(r.refusal)}`);
  return r.record;
}

function refusal(r: Result) {
  if (r.ok) throw new Error("expected a refusal");
  return r.refusal;
}

const draft = (record: SurfaceRecord, target: string, content: Record<string, unknown> | null, baseVersion = 0): SurfaceRecord =>
  run(record, { kind: "setDraft", target, draft: content as never, baseVersion, now: T0 });

describe("createRecord", () => {
  it("starts every question open at rev 1 with nothing sent", () => {
    const r = make(THREE);
    expect(r.rev).toBe(1);
    expect(r.schema).toBe(1);
    expect(Object.values(r.questions).map((q) => q.state)).toEqual(["open", "open", "open"]);
    expect(r.deliveries).toEqual([]);
    expect(r.questions.queue.label).toBe("Queue");
    expect(surfaceStatus(r)).toBe("open");
  });

  it("is resolved at once when there are no questions", () => {
    const r = make({ v: 1, summary: "Just telling you" });
    expect(r.resolvedAt).toBe(T0);
    expect(surfaceStatus(r)).toBe("resolved");
  });

  it("takes review items from inline items, plan steps (nested too) and loaded change items", () => {
    expect(Object.keys(make(REVIEW).questions.chk.items!)).toEqual(["i1", "i2", "x3", "i4"]);
    expect(Object.keys(make(PLAN_REVIEW).questions.steps.items!)).toEqual(["s1", "s1a", "s2"]);
    const changes: SurfaceDocument = {
      v: 1,
      summary: "c",
      questions: [{ id: "files", kind: "review", prompt: "Files", of: "changes" }],
      view: [{ t: "changes" }],
    };
    const r = make(changes, { changeItems: { changes: [{ id: "f1", title: "a.ts" }] } });
    expect(Object.keys(r.questions.files.items!)).toEqual(["f1"]);
    expect(refusal(createRecord({ id: "s_bbbbbb", agentId: "ag1", now: T0, document: changes })).code).toBe("missing-items");
  });

  it("refuses the twenty-first open surface and lists the open ones", () => {
    const open = Array.from({ length: LIMITS.openSurfacesPerAgent }, (_, i) => `s_open${i}`);
    const r = refusal(createRecord({ id: "s_new", agentId: "ag1", now: T0, document: THREE, agentOpenSurfaces: open }));
    expect(r.code).toBe("too-many-open");
    expect(r.open).toEqual(open);
    expect(createRecord({ id: "s_new", agentId: "ag1", now: T0, document: THREE, agentOpenSurfaces: open.slice(1) }).ok).toBe(true);
  });

  it("refuses a revision of a surface that is missing or another agent's", () => {
    const doc = { ...THREE, revises: "s_old" };
    expect(refusal(createRecord({ id: "s_n", agentId: "ag1", now: T0, document: doc })).code).toBe("revises-missing");
    const old = make(THREE, { agentId: "ag2" });
    expect(refusal(createRecord({ id: "s_n", agentId: "ag1", now: T0, document: doc, revised: old })).code).toBe("revises-foreign");
    const mine = make(THREE);
    const ok = createRecord({ id: "s_n", agentId: "ag1", now: T0, document: doc, revised: mine });
    expect(ok.ok && ok.record.revises).toBe("s_old");
  });
});

describe("parseTarget", () => {
  it("reads question and question.item, and nothing else", () => {
    expect(parseTarget("q")).toEqual({ question: "q" });
    expect(parseTarget("q.i1")).toEqual({ question: "q", item: "i1" });
    for (const bad of ["", "Q", "q.", ".i", "q.i.j", 3, null]) expect(parseTarget(bad)).toBeNull();
  });
});

describe("setDraft", () => {
  it("stores a draft with version 1 and raises rev", () => {
    const r = draft(make(THREE), "queue", { value: "bullmq" });
    expect(r.drafts.queue).toEqual({ version: 1, value: "bullmq" });
    expect(r.rev).toBe(2);
  });

  it("refuses a stale write and returns the stored draft (the newer one)", () => {
    const r = draft(make(THREE), "queue", { value: "bullmq" });
    const res = applyCommand(r, { kind: "setDraft", target: "queue", draft: { value: "pg_boss" }, baseVersion: 0, now: T1 });
    const f = refusal(res);
    expect(f.code).toBe("stale-draft");
    expect(f.current).toEqual({ version: 1, value: "bullmq" });
    // and the next write with the right base is accepted
    expect(draft(r, "queue", { value: "pg_boss" }, 1).drafts.queue.version).toBe(2);
  });

  it("clearing keeps a version, so a stale editor cannot bring the draft back", () => {
    let r = draft(make(THREE), "name", { value: "x" });
    r = draft(r, "name", null, 1);
    expect(r.drafts.name).toEqual({ version: 2 });
    const f = refusal(applyCommand(r, { kind: "setDraft", target: "name", draft: { value: "x" }, baseVersion: 1, now: T1 }));
    expect(f.code).toBe("stale-draft");
    expect(f.current).toBeNull();
  });

  it("refuses unknown targets, closed surfaces and questions with a final state", () => {
    const r = make(THREE);
    const set = (target: string, rec = r) => applyCommand(rec, { kind: "setDraft", target, draft: { value: "x" }, baseVersion: 0, now: T0 });
    expect(refusal(set("nope")).code).toBe("unknown-target");
    expect(refusal(set("constructor")).code).toBe("unknown-target");
    expect(refusal(set("queue.i1")).code).toBe("invalid-draft");
    const closed = run(r, { kind: "close", now: T1 });
    expect(refusal(set("queue", closed)).code).toBe("closed");
    const partly = run(
      draft(r, "name", { value: "n" }),
      { kind: "send", targets: [{ target: "name", version: 1 }], now: T1 },
    );
    const f = refusal(set("name", partly));
    expect(f.code).toBe("target-not-open");
    expect(f.problems?.[0].state).toBe("answered");
  });

  it.each([
    ["an option that does not exist", "queue", { value: "nope" }],
    ["a list on a single choice", "queue", { value: ["pg_boss"] }],
    ["a string on a multi choice", "tags", { value: "a" }],
    ["a repeated option", "tags", { value: ["a", "a"] }],
    ["an empty other", "queue", { other: "  " }],
    ["other on a text question", "name", { other: "x" }],
    ["a verdict on a choice", "queue", { verdict: "approve" }],
    ["an unknown field", "queue", { value: "bullmq", extra: 1 }],
    ["skipped with an answer", "queue", { skipped: true, value: "bullmq" }],
    ["skipped that is false", "queue", { skipped: false }],
    ["by recommended on another answer", "queue", { value: "bullmq", by: "recommended" }],
    ["a note over the limit", "queue", { value: "bullmq", note: "x".repeat(LIMITS.note + 1) }],
    ["a text answer over the limit", "name", { value: "x".repeat(LIMITS.answer + 1) }],
  ])("refuses %s", (_name, target, content) => {
    const f = refusal(applyCommand(make(THREE), { kind: "setDraft", target, draft: content as never, baseVersion: 0, now: T0 }));
    expect(f.code).toBe("invalid-draft");
  });

  it("refuses a note where the question turns notes off, and on a review", () => {
    const doc: SurfaceDocument = { v: 1, summary: "s", questions: [{ id: "q", kind: "text", prompt: "p", note: false }, { id: "r", kind: "review", prompt: "r", items: ["a"] }] };
    const r = make(doc);
    expect(refusal(applyCommand(r, { kind: "setDraft", target: "q", draft: { value: "v", note: "n" }, baseVersion: 0, now: T0 })).code).toBe("invalid-draft");
    expect(refusal(applyCommand(r, { kind: "setDraft", target: "r.i1", draft: { verdict: "approve", note: "n" }, baseVersion: 0, now: T0 })).code).toBe("invalid-draft");
  });

  it("checks review drafts: verdicts, a comment switched off, the question id as target, an unknown item", () => {
    const r = make(REVIEW);
    const set = (target: string, content: Record<string, unknown>, rec = r) =>
      applyCommand(rec, { kind: "setDraft", target, draft: content as never, baseVersion: 0, now: T0 });
    expect(set("chk.i1", { verdict: "approve", comment: "ok" }).ok).toBe(true);
    expect(refusal(set("chk.i1", { verdict: "maybe" })).code).toBe("invalid-draft");
    expect(refusal(set("chk.i1", { value: "x" })).code).toBe("invalid-draft");
    expect(refusal(set("chk", { verdict: "approve" })).code).toBe("invalid-draft");
    expect(refusal(set("chk.zz", { verdict: "approve" })).code).toBe("unknown-target");
    const off: SurfaceDocument = { v: 1, summary: "s", questions: [{ id: "q", kind: "review", prompt: "p", items: ["a"], comment: false }] };
    expect(refusal(set("q.i1", { verdict: "approve", comment: "c" }, make(off))).code).toBe("invalid-draft");
    expect(set("chk.i1", { verdict: "approve", by: "recommended" }).ok).toBe(true);
    expect(refusal(set("chk.i1", { verdict: "change", by: "recommended" })).code).toBe("invalid-draft");
  });

  it("changes nothing and returns the refusal without touching the record", () => {
    const r = make(THREE);
    applyCommand(r, { kind: "setDraft", target: "queue", draft: { value: "nope" } as never, baseVersion: 0, now: T0 });
    expect(r.drafts).toEqual({});
    expect(r.rev).toBe(1);
  });
});

describe("setComment", () => {
  const cmt = (rec: SurfaceRecord, on: string, text: string | null, baseVersion = 0): Result =>
    applyCommand(rec, { kind: "setComment", on, text, baseVersion, now: T0 });

  it("stores a comment on a block item with its title", () => {
    const r = (cmt(make(REVIEW), "plan.s1a", "why?") as { record: SurfaceRecord }).record;
    expect(r.comments["plan.s1a"]).toEqual({ version: 1, text: "why?", title: "Nested", delivery: null });
  });

  it("refuses unknown items, stale versions, long text and closed surfaces", () => {
    const rec = make(REVIEW);
    expect(refusal(cmt(rec, "plan.zz", "x")).code).toBe("unknown-target");
    expect(refusal(cmt(rec, "constructor.s1", "x")).code).toBe("unknown-target");
    expect(refusal(cmt(rec, "plan", "x")).code).toBe("unknown-target");
    const one = (cmt(rec, "plan.s1", "a") as { record: SurfaceRecord }).record;
    const stale = refusal(cmt(one, "plan.s1", "b", 0));
    expect(stale.code).toBe("stale-draft");
    expect((stale.current as { text: string }).text).toBe("a");
    expect(refusal(cmt(rec, "plan.s1", "x".repeat(LIMITS.answer + 1))).code).toBe("invalid-draft");
    expect(refusal(cmt(run(rec, { kind: "close", now: T1 }), "plan.s1", "x")).code).toBe("closed");
  });
});

describe("send", () => {
  it("sends two of three answers, creates the delivery in the same record, and takes the third later", () => {
    let r = make(THREE);
    r = draft(r, "queue", { value: "bullmq" });
    r = draft(r, "name", { value: "mailer" });
    const sent = applyCommand(r, { kind: "send", targets: [{ target: "queue", version: 1 }, { target: "name", version: 1 }], now: T1 });
    if (!sent.ok) throw new Error(JSON.stringify(sent.refusal));
    expect(sent.record.rev).toBe(r.rev + 1);
    expect(sent.record.questions.queue.state).toBe("answered");
    expect(sent.record.questions.name.state).toBe("answered");
    expect(sent.record.questions.tags.state).toBe("open");
    expect(surfaceStatus(sent.record)).toBe("open");
    expect(sent.record.drafts).toEqual({});
    const d = sent.record.deliveries[0];
    expect(d).toMatchObject({ n: 1, messageId: "docket:s_aaaaaa:1", state: "queued", attempts: 0, targets: ["queue", "name"] });
    expect(d.text).toContain("Queue → BullMQ");
    expect(d.text).toContain("Name it? → mailer");
    expect(d.text).toContain("Still open: Tags?");
    expect(sent.delivery).toBe(d);

    let r2 = draft(sent.record, "tags", { value: ["a", "c"] });
    const last = run(r2, { kind: "send", targets: [{ target: "tags", version: 1 }], now: T1 });
    expect(last.deliveries.map((x) => x.n)).toEqual([1, 2]);
    expect(last.deliveries[0]).toBe(sent.record.deliveries[0]); // the first delivery is not touched
    expect(last.deliveries[1].text).not.toContain("Queue");
    expect(last.deliveries[1].text).not.toContain("Still open");
    expect(surfaceStatus(last)).toBe("resolved");
    expect(last.resolvedAt).toBe(T1);
  });

  it("refuses a send that names an old draft version and carries both drafts", () => {
    let r = draft(make(THREE), "queue", { value: "bullmq" });
    r = draft(r, "queue", { value: "pg_boss" }, 1);
    const f = refusal(applyCommand(r, { kind: "send", targets: [{ target: "queue", version: 1 }], now: T1 }));
    expect(f.code).toBe("stale-send");
    expect(f.conflicts).toEqual([{ target: "queue", sentVersion: 1, current: { version: 2, value: "pg_boss" } }]);
    expect(r.deliveries).toEqual([]);
  });

  it("refuses a send of a draft cleared meanwhile, naming the empty state", () => {
    let r = draft(make(THREE), "name", { value: "x" });
    r = draft(r, "name", null, 1);
    const f = refusal(applyCommand(r, { kind: "send", targets: [{ target: "name", version: 1 }], now: T1 }));
    expect(f.code).toBe("stale-send");
    expect(f.conflicts?.[0].current).toBeNull();
  });

  it("refuses a target with no draft at all", () => {
    const f = refusal(applyCommand(make(THREE), { kind: "send", targets: [{ target: "name", version: 0 }], now: T1 }));
    expect(f.code).toBe("stale-send");
  });

  it("refuses incomplete drafts: empty text, no choice, both option and other, multi bounds", () => {
    const send = (target: string, content: Record<string, unknown>) =>
      applyCommand(draft(make(THREE), target, content), { kind: "send", targets: [{ target, version: 1 }], now: T1 });
    expect(refusal(send("name", { note: "n" })).code).toBe("incomplete");
    expect(refusal(send("name", { value: "  " })).code).toBe("incomplete");
    expect(refusal(send("queue", { note: "n" })).code).toBe("incomplete");
    expect(refusal(send("queue", { value: "bullmq", other: "x" })).code).toBe("incomplete");
    expect(refusal(send("tags", { value: [] })).code).toBe("incomplete");
    expect(refusal(send("tags", { value: ["a", "b"], other: "z" })).code).toBe("incomplete");
    expect(send("tags", { value: ["a"], other: "z" }).ok).toBe(true);
  });

  it("refuses unknown, repeated and non-open targets, and sending nothing", () => {
    const r = draft(make(THREE), "name", { value: "x" });
    const send = (rec: SurfaceRecord, targets: { target: string; version: number }[], extra: Partial<Extract<Command, { kind: "send" }>> = {}) =>
      applyCommand(rec, { kind: "send", targets, now: T1, ...extra });
    expect(refusal(send(r, [{ target: "zzz", version: 1 }])).code).toBe("unknown-target");
    expect(refusal(send(r, [{ target: "constructor", version: 1 }])).code).toBe("unknown-target");
    expect(refusal(send(r, [{ target: "name", version: 1 }, { target: "name", version: 1 }])).code).toBe("duplicate-target");
    expect(refusal(send(r, [])).code).toBe("nothing-to-send");
    const answered = run(r, { kind: "send", targets: [{ target: "name", version: 1 }], now: T1 });
    expect(refusal(send(answered, [{ target: "name", version: 1 }])).code).toBe("target-not-open");
    expect(refusal(send(run(r, { kind: "close", now: T1 }), [{ target: "name", version: 1 }])).code).toBe("closed");
    expect(refusal(send(r, [{ target: "name" } as never])).code).toBe("invalid");
  });

  it("skips the rest: skipped questions are final and delivered as no decision", () => {
    let r = draft(make(THREE), "queue", { value: "pg_boss", by: "recommended" });
    const sent = run(r, { kind: "send", targets: [{ target: "queue", version: 1 }], skip: ["name", "tags"], now: T1 });
    expect(sent.questions.name.state).toBe("skipped");
    expect(sent.questions.tags.state).toBe("skipped");
    expect(surfaceStatus(sent)).toBe("resolved");
    expect(sent.deliveries[0].text).toContain("Name it? → skipped (no decision; not approval)");
    expect(sent.deliveries[0].text).toContain("(your recommendation)");
    expect(sent.deliveries[0].text).not.toContain("Still open");
  });

  it("sends a draft marked skipped as a skip", () => {
    const r = draft(make(THREE), "name", { skipped: true });
    const sent = run(r, { kind: "send", targets: [{ target: "name", version: 1 }], now: T1 });
    expect(sent.questions.name.state).toBe("skipped");
  });

  it("refuses to skip what is already final", () => {
    const sent = run(draft(make(THREE), "name", { value: "x" }), { kind: "send", targets: [{ target: "name", version: 1 }], now: T1 });
    expect(refusal(applyCommand(sent, { kind: "send", targets: [], skip: ["name"], now: T1 })).code).toBe("target-not-open");
  });

  it("sends two of four review items, then the rest", () => {
    let r = make(REVIEW);
    r = draft(r, "chk.i1", { verdict: "approve", by: "recommended" });
    r = draft(r, "chk.x3", { verdict: "change", comment: "split it" });
    const sent = run(r, { kind: "send", targets: [{ target: "chk.i1", version: 1 }, { target: "chk.x3", version: 1 }], now: T1 });
    expect(sent.questions.chk.state).toBe("open");
    expect(sent.questions.chk.items!.i1.state).toBe("answered");
    expect(sent.questions.chk.items!.x3.answer).toMatchObject({ verdict: "change", comment: "split it" });
    expect(sent.questions.chk.items!.i2.state).toBe("open");
    expect(sent.deliveries[0].text).toContain('i1 approve; x3 change: "split it"');
    expect(sent.deliveries[0].text).toContain("Still open: items i2, i4");
    const rest = run(sent, { kind: "send", targets: [], skip: ["chk"], now: T1 });
    expect(rest.questions.chk.items!.i2.state).toBe("skipped");
    expect(rest.questions.chk.state).toBe("answered");
    expect(surfaceStatus(rest)).toBe("resolved");
  });

  it("refuses review sends: a comment-only draft, the question as target, an answered item", () => {
    const r = draft(make(REVIEW), "chk.i1", { comment: "hm" });
    expect(refusal(applyCommand(r, { kind: "send", targets: [{ target: "chk.i1", version: 1 }], now: T1 })).code).toBe("incomplete");
    expect(refusal(applyCommand(r, { kind: "send", targets: [{ target: "chk", version: 1 }], now: T1 })).code).toBe("unknown-target");
    const ok = draft(make(REVIEW), "chk.i1", { verdict: "approve" });
    const sent = run(ok, { kind: "send", targets: [{ target: "chk.i1", version: 1 }], now: T1 });
    expect(refusal(applyCommand(sent, { kind: "send", targets: [{ target: "chk.i1", version: 1 }], now: T1 })).code).toBe("target-not-open");
  });

  it("names plan steps in a plan review and the block noun in still-open text", () => {
    const r = draft(make(PLAN_REVIEW), "steps.s1", { verdict: "do" });
    const sent = run(r, { kind: "send", targets: [{ target: "steps.s1", version: 1 }], now: T1 });
    expect(sent.deliveries[0].text).toContain("Still open: plan steps s1a, s2");
  });

  it("sends a comment with its version, and an edit afterwards makes a new unsent comment", () => {
    let r = make(PLAN_REVIEW);
    r = run(r, { kind: "setComment", on: "plan.s2", text: "rename", baseVersion: 0, now: T0 });
    r = draft(r, "steps.s1", { verdict: "do" });
    const sent = run(r, { kind: "send", targets: [{ target: "steps.s1", version: 1 }], comments: [{ on: "plan.s2", version: 1 }], now: T1 });
    expect(sent.comments["plan.s2"].delivery).toBe(1);
    expect(sent.deliveries[0].comments).toEqual(["plan.s2"]);
    expect(sent.deliveries[0].text).toContain("Comment on plan step s2 (Step 2): rename");
    const edited = run(sent, { kind: "setComment", on: "plan.s2", text: "rename it", baseVersion: 1, now: T1 });
    expect(edited.comments["plan.s2"]).toMatchObject({ version: 2, delivery: null });
    expect(edited.deliveries[0].text).toContain("rename\n");
  });

  it("refuses comment sends that are stale, missing, repeated or already sent", () => {
    let r = run(make(PLAN_REVIEW), { kind: "setComment", on: "plan.s2", text: "a", baseVersion: 0, now: T0 });
    r = run(r, { kind: "setComment", on: "plan.s2", text: "b", baseVersion: 1, now: T0 });
    const send = (rec: SurfaceRecord, comments: { on: string; version: number }[]) => applyCommand(rec, { kind: "send", targets: [], comments, now: T1 });
    const stale = refusal(send(r, [{ on: "plan.s2", version: 1 }]));
    expect(stale.code).toBe("stale-send");
    expect((stale.conflicts![0].current as { text: string }).text).toBe("b");
    expect(refusal(send(r, [{ on: "plan.s1", version: 1 }])).problems?.[0].code).toBe("no-comment");
    expect(refusal(send(r, [{ on: "plan.zz", version: 1 }])).problems?.[0].code).toBe("unknown-target");
    expect(refusal(send(r, [{ on: "plan.s2", version: 2 }, { on: "plan.s2", version: 2 }])).problems?.[0].code).toBe("duplicate-target");
    const sent = run(r, { kind: "send", targets: [], comments: [{ on: "plan.s2", version: 2 }], now: T1 });
    expect(refusal(send(sent, [{ on: "plan.s2", version: 2 }])).problems?.[0].code).toBe("no-comment");
  });

  it("sends nothing on a failed send: the record is untouched", () => {
    const r = draft(make(THREE), "queue", { value: "bullmq" });
    applyCommand(r, { kind: "send", targets: [{ target: "queue", version: 1 }, { target: "name", version: 1 }], now: T1 });
    expect(r.deliveries).toEqual([]);
    expect(r.questions.queue.state).toBe("open");
  });
});

describe("close", () => {
  it("closes every open question, keeps the answered ones, and marks the surface closed", () => {
    const answered = run(draft(make(THREE), "name", { value: "x" }), { kind: "send", targets: [{ target: "name", version: 1 }], now: T1 });
    const closed = run(answered, { kind: "close", reason: "decided elsewhere", now: T1 });
    expect(closed.questions.name.state).toBe("answered");
    expect(closed.questions.queue.state).toBe("closed");
    expect(closed.closed).toEqual({ at: T1, by: "agent", reason: "decided elsewhere" });
    expect(closed.resolvedAt).toBe(T1);
  });

  it("closes named questions only; the surface closes when none is left open", () => {
    const part = run(make(THREE), { kind: "close", questions: ["queue"], now: T1 });
    expect(part.closed).toBeNull();
    expect(surfaceStatus(part)).toBe("open");
    const rest = run(part, { kind: "close", questions: ["name", "tags"], now: T1 });
    expect(rest.closed?.by).toBe("agent");
  });

  it("closes open review items and keeps answered ones", () => {
    const sent = run(draft(make(REVIEW), "chk.i1", { verdict: "approve" }), { kind: "send", targets: [{ target: "chk.i1", version: 1 }], now: T1 });
    const closed = run(sent, { kind: "close", now: T1 });
    expect(closed.questions.chk.items!.i1.state).toBe("answered");
    expect(closed.questions.chk.items!.i2.state).toBe("closed");
    expect(closed.questions.chk.state).toBe("answered");
  });

  it("refuses a closed surface, unknown questions and questions that are final", () => {
    const r = make(THREE);
    expect(refusal(applyCommand(r, { kind: "close", questions: ["zz"], now: T1 })).code).toBe("unknown-target");
    const part = run(r, { kind: "close", questions: ["queue"], now: T1 });
    const f = refusal(applyCommand(part, { kind: "close", questions: ["queue"], now: T1 }));
    expect(f.code).toBe("unknown-target");
    expect(f.problems?.[0].code).toBe("target-not-open");
    expect(refusal(applyCommand(run(r, { kind: "close", now: T1 }), { kind: "close", now: T1 })).code).toBe("closed");
  });
});

describe("closeReplaced", () => {
  it("closes an open surface and points at the new one; repeating changes nothing", () => {
    const old = make(THREE);
    const once = run(old, { kind: "closeReplaced", by: "s_new", now: T1 });
    expect(once.replacedBy).toBe("s_new");
    expect(once.closed).toEqual({ at: T1, by: "replaced" });
    expect(once.questions.queue.state).toBe("closed");
    expect(surfaceStatus(once)).toBe("resolved");
    const again = applyCommand(once, { kind: "closeReplaced", by: "s_new", now: T1 });
    expect(again.ok && again.record).toBe(once);
  });

  it("keeps the answers of a surface already resolved and only links it", () => {
    const resolved = run(draft(make(THREE), "name", { value: "x" }), { kind: "send", targets: [{ target: "name", version: 1 }], skip: ["queue", "tags"], now: T1 });
    const linked = run(resolved, { kind: "closeReplaced", by: "s_new", now: T1 });
    expect(linked.replacedBy).toBe("s_new");
    expect(linked.closed).toBeNull();
    expect(linked.questions.name.state).toBe("answered");
  });

  it("keeps the first reviser", () => {
    const first = run(make(THREE), { kind: "closeReplaced", by: "s_one", now: T1 });
    const second = applyCommand(first, { kind: "closeReplaced", by: "s_two", now: T1 });
    expect(second.ok && second.record.replacedBy).toBe("s_one");
  });
});

describe("holdOnArchive and agentRestored", () => {
  const withDelivery = () =>
    run(draft(make(THREE), "name", { value: "x" }), { kind: "send", targets: [{ target: "name", version: 1 }], now: T1 });

  it("holds queued and uncertain deliveries, leaves delivered ones, and marks the surface orphaned", () => {
    let r = withDelivery();
    r = run(draft(r, "queue", { value: "bullmq" }), { kind: "send", targets: [{ target: "queue", version: 1 }], now: T1 });
    r = run(r, { kind: "updateDelivery", n: 1, to: "delivered", now: T1 });
    r = run(r, { kind: "updateDelivery", n: 2, to: "uncertain", now: T1 });
    const held = run(r, { kind: "holdOnArchive", now: T1 });
    expect(held.deliveries.map((d) => d.state)).toEqual(["delivered", "held"]);
    expect(held.orphanedAt).toBe(T1);
    expect(surfaceStatus(held)).toBe("orphaned");
    expect(applyCommand(held, { kind: "holdOnArchive", now: T1 }).ok && (applyCommand(held, { kind: "holdOnArchive", now: T1 }) as { record: SurfaceRecord }).record).toBe(held);
  });

  it("creates a delivery held when the agent was archived, and Retry after restore queues it", () => {
    const held = run(make(THREE), { kind: "holdOnArchive", now: T1 });
    const sent = run(draft(held, "name", { value: "x" }), { kind: "send", targets: [{ target: "name", version: 1 }], now: T1 });
    expect(sent.deliveries[0].state).toBe("held");
    const restored = run(sent, { kind: "agentRestored", now: T1 });
    expect(restored.orphanedAt).toBeNull();
    expect(restored.deliveries[0].state).toBe("held");
    expect(run(restored, { kind: "retryDelivery", n: 1, now: T1 }).deliveries[0].state).toBe("queued");
    const same = applyCommand(make(THREE), { kind: "agentRestored", now: T1 });
    expect(same.ok).toBe(true);
  });
});

describe("delivery states", () => {
  const queued = () => run(draft(make(THREE), "name", { value: "x" }), { kind: "send", targets: [{ target: "name", version: 1 }], now: T1 });
  const to = (rec: SurfaceRecord, state: never, n = 1) => applyCommand(rec, { kind: "updateDelivery", n, to: state, now: T1 });

  it("follows the table: queued to uncertain to delivered, which is terminal", () => {
    let r = run(queued(), { kind: "updateDelivery", n: 1, to: "uncertain", now: T1 });
    r = run(r, { kind: "updateDelivery", n: 1, to: "delivered", now: T1 });
    expect(r.deliveries[0]).toMatchObject({ state: "delivered", deliveredAt: T1 });
    for (const s of ["queued", "held", "uncertain", "failed", "removed"]) expect(refusal(to(r, s as never)).code).toBe("bad-delivery-transition");
  });

  it("refuses moves the table does not have, and unknown deliveries", () => {
    const r = queued();
    expect(refusal(to(run(r, { kind: "updateDelivery", n: 1, to: "failed", now: T1 }), "uncertain" as never)).code).toBe("bad-delivery-transition");
    expect(refusal(to(run(r, { kind: "updateDelivery", n: 1, to: "held", now: T1 }), "delivered" as never)).code).toBe("bad-delivery-transition");
    expect(refusal(to(r, "delivered" as never, 7)).code).toBe("unknown-delivery");
  });

  it("records attempts, enqueued and the text that arrived; a patch alone is a change, a repeat is not", () => {
    const r = queued();
    const p = run(r, { kind: "updateDelivery", n: 1, patch: { attempts: 1, enqueued: true, receivedText: "rewritten", lastError: "x" }, now: T1 });
    expect(p.deliveries[0]).toMatchObject({ attempts: 1, enqueued: true, receivedText: "rewritten", lastError: "x", state: "queued" });
    const same = applyCommand(p, { kind: "updateDelivery", n: 1, patch: { attempts: 1 }, now: "2026-11-22T00:00:00.000Z" });
    expect(same.ok && same.record).toBe(p);
    const cleared = run(p, { kind: "updateDelivery", n: 1, patch: { lastError: null }, now: T1 });
    expect(cleared.deliveries[0].lastError).toBeUndefined();
    const sameText = run(r, { kind: "updateDelivery", n: 1, patch: { receivedText: r.deliveries[0].text }, now: T1 });
    expect(sameText.deliveries[0].receivedText).toBeUndefined();
  });

  it("retries held, failed, removed and uncertain with the frozen text, and refuses queued and delivered", () => {
    const r = queued();
    const text = r.deliveries[0].text;
    for (const s of ["held", "failed", "removed", "uncertain"]) {
      const moved = run(r, { kind: "updateDelivery", n: 1, to: s as never, patch: { attempts: 3, enqueued: true, lastError: "e" }, now: T1 });
      const back = run(moved, { kind: "retryDelivery", n: 1, messageId: "docket:s_aaaaaa:1:r1", now: T1 });
      expect(back.deliveries[0]).toMatchObject({ state: "queued", attempts: 0, enqueued: false, text, messageId: "docket:s_aaaaaa:1:r1" });
      expect(back.deliveries[0].lastError).toBeUndefined();
    }
    expect(refusal(applyCommand(r, { kind: "retryDelivery", n: 1, now: T1 })).code).toBe("bad-delivery-transition");
    const delivered = run(r, { kind: "updateDelivery", n: 1, to: "delivered", now: T1 });
    expect(refusal(applyCommand(delivered, { kind: "retryDelivery", n: 1, now: T1 })).code).toBe("bad-delivery-transition");
    expect(refusal(applyCommand(r, { kind: "retryDelivery", n: 9, now: T1 })).code).toBe("unknown-delivery");
  });
});

describe("deleteDecisions", () => {
  const answered = () => {
    let r = draft(make(THREE), "queue", { value: "bullmq", note: "because" });
    r = draft(r, "name", { value: "mailer" });
    r = run(r, { kind: "send", targets: [{ target: "queue", version: 1 }, { target: "name", version: 1 }], skip: ["tags"], now: T1 });
    return run(r, { kind: "updateDelivery", n: 1, to: "delivered", now: T1 });
  };

  it("redacts the question and blanks a delivered text once all its questions are gone", () => {
    const r = answered();
    const one = run(r, { kind: "deleteDecisions", questions: ["queue"], now: T1 });
    expect(one.questions.queue).toMatchObject({ deleted: true, prompt: "" });
    expect(one.questions.queue.answer).toBeUndefined();
    expect(one.deliveries[0].text).not.toBe("");
    const all = run(one, { kind: "deleteDecisions", questions: ["name"], now: T1 });
    expect(all.deliveries[0].text).toBe("");
  });

  it("leaves skipped questions, and a repeat changes nothing", () => {
    const r = answered();
    const del = run(r, { kind: "deleteDecisions", now: T1 });
    expect(del.questions.tags.state).toBe("skipped");
    expect(del.questions.tags.deleted).toBeUndefined();
    const again = applyCommand(del, { kind: "deleteDecisions", now: T1 });
    expect(again.ok && again.record).toBe(del);
  });

  it("refuses unknown questions", () => {
    expect(refusal(applyCommand(answered(), { kind: "deleteDecisions", questions: ["zz"], now: T1 })).code).toBe("unknown-target");
  });
});

describe("compact", () => {
  const resolved = () =>
    run(draft(make(REVIEW), "chk.i1", { verdict: "approve" }), { kind: "send", targets: [{ target: "chk.i1", version: 1 }], skip: ["chk"], now: T1 });

  it("drops the view and evidence references after retention and keeps answers and texts", () => {
    const withComment = run(make(REVIEW), { kind: "setComment", on: "plan.s1", text: "unsent", baseVersion: 0, now: T0 });
    const r = run(draft(withComment, "chk.i1", { verdict: "approve" }), { kind: "send", targets: [{ target: "chk.i1", version: 1 }], skip: ["chk"], now: T1 });
    expect(r.comments["plan.s1"].delivery).toBeNull();
    const done = r.resolvedAt as string;
    const later = new Date(Date.parse(done) + 31 * 86_400_000).toISOString();
    const c = run(r, { kind: "compact", now: later });
    expect(c.document).toBeNull();
    expect(c.snapshots).toEqual({});
    expect(c.blockItems).toEqual({});
    expect(c.comments).toEqual({});
    expect(c.compactedAt).toBe(later);
    expect(c.questions.chk.items!.i1.answer?.verdict).toBe("approve");
    expect(c.questions.chk.items!.i1.title).toBe("one");
    expect(c.deliveries).toEqual(r.deliveries);
  });

  it("refuses an open surface, an early compaction and a repeat", () => {
    const open = make(THREE);
    expect(refusal(applyCommand(open, { kind: "compact", now: "2030-01-01T00:00:00.000Z" })).code).toBe("not-resolved");
    const r = resolved();
    expect(refusal(applyCommand(r, { kind: "compact", now: T1 })).code).toBe("not-resolved");
    const later = "2027-01-01T00:00:00.000Z";
    const c = run(r, { kind: "compact", now: later });
    expect(refusal(applyCommand(c, { kind: "compact", now: later })).code).toBe("not-resolved");
  });

  it("expires an orphaned surface's open questions and compacts it", () => {
    const held = run(make(THREE), { kind: "holdOnArchive", now: T0 });
    expect(refusal(applyCommand(held, { kind: "compact", now: T1 })).code).toBe("not-resolved");
    const c = run(held, { kind: "compact", now: "2027-01-01T00:00:00.000Z" });
    expect(c.questions.queue.state).toBe("closed");
    expect(c.closed?.by).toBe("expired");
  });

  it("honours a shorter retention period", () => {
    const r = resolved();
    const at = new Date(Date.parse(r.resolvedAt as string) + 2 * 86_400_000).toISOString();
    expect(refusal(applyCommand(r, { kind: "compact", now: at })).code).toBe("not-resolved");
    expect(applyCommand(r, { kind: "compact", now: at, retentionDays: 1 }).ok).toBe(true);
  });
});

describe("applyCommand", () => {
  it("refuses an unknown command", () => {
    expect(refusal(applyCommand(make(THREE), { kind: "bogus" } as never)).code).toBe("invalid");
  });

  it("raises rev by one per change and never mutates its input", () => {
    const r = make(THREE);
    const frozen = JSON.stringify(r);
    const next = draft(r, "queue", { value: "bullmq" });
    expect(next.rev).toBe(r.rev + 1);
    expect(JSON.stringify(r)).toBe(frozen);
  });
});
