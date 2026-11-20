import { describe, expect, it } from "vitest";
import { LIMITS } from "./limits";
import { deliveryMessage, itemNoun, renderText, truncateRendered } from "./text";
import { utf8Bytes } from "./ids";
import { validateDocument } from "./validate";

// Spec 27.5.
const SPEC_DOC = {
  v: 1,
  summary: "Two choices before I start the queue work.",
  context: "Planning the mailer's move off cron; nothing is changed yet.",
  questions: [
    {
      id: "queue",
      kind: "choice",
      prompt: "Which queue?",
      recommend: "pg_boss",
      options: [
        { id: "pg_boss", label: "pg-boss", detail: "Uses our Postgres" },
        { id: "bullmq", label: "BullMQ", detail: "Faster, needs Redis" },
      ],
    },
    { id: "steps", kind: "review", prompt: "Plan steps", of: "plan", verdicts: ["do", "drop"], recommend: "do" },
  ],
  view: [
    {
      t: "plan",
      steps: [
        { id: "s1", title: "Add the jobs table" },
        { id: "s2", title: "Move the mailer onto the queue", ref: "src/mail/send.ts:40-88", after: ["s1"] },
      ],
    },
  ],
} as const;

const SPEC_TEXT = `Two choices before I start the queue work.
Planning the mailer's move off cron; nothing is changed yet.

plan
  s1  Add the jobs table  [todo]
  s2  Move the mailer onto the queue  [todo]  src/mail/send.ts:40-88  after s1

1. queue: Which queue?
   a. pg_boss  pg-boss: Uses our Postgres  (recommended)
   b. bullmq   BullMQ: Faster, needs Redis
2. steps: Plan steps, per item: do | drop  (recommended: do)`;

describe("text form (27.5)", () => {
  it("matches the spec example", () => {
    expect(renderText(SPEC_DOC as never)).toBe(SPEC_TEXT);
  });

  it("adds a meanwhile line only when it is not stop", () => {
    const stop = renderText({ ...SPEC_DOC, meanwhile: "stop" } as never);
    expect(stop).not.toContain("Meanwhile");
    const other = renderText({ ...SPEC_DOC, meanwhile: "other_work" } as never);
    expect(other.split("\n")[2]).toMatch(/^Meanwhile:/);
  });

  it("renders a string block as Markdown and a code block by id", () => {
    const text = renderText({ v: 1, summary: "S", view: ["Some **markdown**", { t: "code", s: "x = 1" }] } as never);
    expect(text).toContain("Some **markdown**");
    expect(text).toContain("code");
  });

  it("shows loaded changes with +N −M counts", () => {
    const text = renderText(
      { v: 1, summary: "S", view: [{ t: "changes", of: "worktree" }] } as never,
      { changes: { changes: [{ id: "f1", path: "src/a.ts", status: "changed", added: 3, removed: 1 }] } },
    );
    expect(text).toContain("f1");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("+3 −1");
  });

  it("truncates at a line boundary with a note", () => {
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const cut = truncateRendered(long);
    expect(utf8Bytes(cut)).toBeLessThanOrEqual(LIMITS.renderedBytes + 80);
    expect(cut).toMatch(/\[cut: \d+ more lines not shown\]$/);
    expect(cut.split("\n").slice(0, -1).every((l) => /^line \d+$/.test(l))).toBe(true);
  });

  it("leaves short text alone", () => {
    expect(truncateRendered(SPEC_TEXT)).toBe(SPEC_TEXT);
  });
});

describe("delivery message (8.4)", () => {
  // The spec's example, with the plugin id in the header (sections 24 and 27.6).
  const EXPECTED = `[docket s_8f2k, delivery 2]
Which queue? → pg-boss
  Note: Only while we stay on Postgres 16
Auth method → Other: Reuse the SSO proxy
Channels → Email, Push (your recommendation)
Plan steps → s1 do; s3 drop: "Keep the cron fallback one release"
Needed by? → skipped (no decision; not approval)
Comment on plan step s2: Check the retry settings first
Still open: Retries; plan steps s2, s4`;

  const input = {
    surfaceId: "s_8f2k",
    delivery: 2,
    answers: [
      { label: "Which queue?", values: ["pg-boss"], note: "Only while we stay on Postgres 16" },
      { label: "Auth method", other: "Reuse the SSO proxy" },
      { label: "Channels", values: ["Email", "Push"], byRecommended: true },
      {
        label: "Plan steps",
        items: [
          { id: "s1", verdict: "do" },
          { id: "s3", verdict: "drop", comment: "Keep the cron fallback one release" },
        ],
      },
      { label: "Needed by?", skipped: true },
    ],
    comments: [{ noun: "plan step", id: "s2", text: "Check the retry settings first" }],
    stillOpen: [{ label: "Retries" }, { noun: "plan step", ids: ["s2", "s4"] }],
  };

  it("reproduces the spec example", () => {
    expect(deliveryMessage(input)).toBe(EXPECTED);
  });

  it("names the item's title in a comment when it is known", () => {
    const m = deliveryMessage({ ...input, answers: [], stillOpen: [], comments: [{ noun: "plan step", id: "s2", title: "Move the mailer", text: "Check it" }] });
    expect(m).toBe("[docket s_8f2k, delivery 2]\nComment on plan step s2 (Move the mailer): Check it");
  });

  it("omits Still open when nothing is open", () => {
    expect(deliveryMessage({ ...input, stillOpen: [] })).not.toContain("Still open");
  });

  it("indents the continuation lines of a multi-line answer", () => {
    const m = deliveryMessage({ surfaceId: "s_8f2k", delivery: 1, answers: [{ label: "Why", values: ["a\nb"] }], comments: [], stillOpen: [] });
    expect(m).toBe("[docket s_8f2k, delivery 1]\nWhy → a\n  b");
  });

  it("uses a singular noun for one open item", () => {
    const m = deliveryMessage({ surfaceId: "s_8f2k", delivery: 1, answers: [], comments: [], stillOpen: [{ noun: "plan step", ids: ["s2"] }] });
    expect(m).toContain("Still open: plan step s2");
  });

  it("names items by block type", () => {
    expect(itemNoun("plan")).toBe("plan step");
    expect(itemNoun("changes")).toBe("changed file");
    expect(itemNoun("other")).toBe("item");
  });
});

describe("nothing the agent wrote is dropped from the text form", () => {
  const render = (view: unknown[], questions?: unknown[]): string =>
    renderText({ v: 1, summary: "S", context: "C", view, questions } as never);

  it("plan step detail, indented under its step", () => {
    const text = render([{ t: "plan", steps: [{ id: "s1", title: "Remove fallback", detail: "No fallback if worker fails\nsecond line", children: [{ id: "s2", title: "Inner", detail: "deep" }] }] }]);
    expect(text).toContain("  s1  Remove fallback  [todo]\n    No fallback if worker fails\n    second line\n    s2  Inner  [todo]\n      deep");
  });

  it("review item detail and ref", () => {
    const text = render([], [{ id: "r", kind: "review", prompt: "P", items: [{ id: "a", title: "A", detail: "why", ref: "x.ts:3" }] }]);
    expect(text).toContain("   a  A  x.ts:3\n      why");
  });

  it("a diff code block is fenced as diff", () => {
    expect(render([{ t: "code", s: "+a", diff: true }])).toContain("```diff");
  });

  it("every view the validator accepts renders without throwing; the ones it refuses are not rendered", () => {
    const accepted = [
      { t: "changes", paths: ["src/", "lib/"] },
      { t: "changes" },
      { t: "code", file: "a.ts", from: 3 },
      { t: "plan", steps: [{ id: "s1", title: "T", files: "a.ts", after: [] }] },
    ];
    const refused = [{ t: "changes", paths: "src/" }];
    const doc = (v: unknown) => ({ v: 1, summary: "S", view: [v] });
    for (const v of accepted) {
      const r = validateDocument(doc(v));
      expect(r.problems, JSON.stringify(v)).toEqual([]);
      expect(() => renderText(r.document!)).not.toThrow();
    }
    for (const v of refused) expect(validateDocument(doc(v)).ok, JSON.stringify(v)).toBe(false);
  });

  it("a block id that names an inherited property finds no evidence", () => {
    for (const id of ["constructor", "toString", "__proto__"]) {
      const code = renderText({ v: 1, summary: "S", view: [{ t: "code", id, file: "a.ts" }] } as never, { code: {} });
      expect(code).toContain("a.ts");
      expect(code).not.toContain("```");
      const changes = renderText({ v: 1, summary: "S", view: [{ t: "changes", id }] } as never, { changes: {} });
      expect(changes).toContain("files are read when the surface is shown");
    }
  });

  it("names a review's target block when two blocks could be meant", () => {
    const plans = (of: string) => ({
      v: 1, summary: "S", context: "C",
      view: [{ t: "plan", id: "first", steps: [{ id: "s1", title: "A" }] }, { t: "plan", id: "second", steps: [{ id: "s1", title: "B" }] }],
      questions: [{ id: "r", kind: "review", prompt: "P", of, recommend: { s1: "approve" } }],
    });
    expect(validateDocument(plans("first")).ok).toBe(true);
    expect(validateDocument(plans("second")).ok).toBe(true);
    const a = renderText(plans("first") as never);
    const b = renderText(plans("second") as never);
    expect(a).not.toBe(b);
    expect(a).toContain("1. r: P, of first, per item");
    expect(b).toContain("of second");
  });

  it("renders revises, selection bounds and fixed options", () => {
    const text = renderText({
      v: 1, summary: "S", context: "C", revises: "s_abc123",
      questions: [
        { id: "m", kind: "choice", prompt: "M", multi: true, min: 2, max: 3, other: false, options: ["a", "b", "c"] },
        { id: "n", kind: "choice", prompt: "N", multi: true, min: 1, options: ["a"] },
      ],
    } as never);
    expect(text).toContain("Revises s_abc123.");
    expect(text).toContain("1. m: M, pick 2 to 3, no custom answer");
    expect(text).toContain("2. n: N, pick at least 1");
  });
});
