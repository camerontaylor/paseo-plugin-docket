import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acceptDocument, acceptToolInput, formatProblems } from "./accept";
import { type Doc, INVALID_CASES, STAGE_CASES, base } from "./fixtures/invalid";
import { deliveryMessageId, isItemId, isOptionId, isSurfaceId, newSurfaceId, utf8Bytes } from "./ids";
import { validateDocument } from "./validate";

const fixture = (name: string): Doc => JSON.parse(readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
const clone = (d: Doc): Doc => JSON.parse(JSON.stringify(d));

describe("the base fixture", () => {
  it("is valid with no warnings", () => {
    const r = validateDocument(base());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

describe("spec examples (section 20)", () => {
  it("20.1 in its stage-1 form (the date question as text) validates", () => {
    const r = validateDocument(fixture("spec-20-1-questions-only.json"));
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("20.1 as written is refused by name: the date question kind is stage 2", () => {
    const r = validateDocument(fixture("spec-20-1-verbatim.json"));
    expect(r.problems).toEqual([
      expect.objectContaining({ pointer: "/questions/2/kind", stage: 2, message: expect.stringContaining("`date` is not available yet") }),
    ]);
  });

  it("20.3 in its stage-1 form (no compare or details blocks) validates", () => {
    const r = validateDocument(fixture("spec-20-3-stage1-form.json"));
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("20.3 as written is refused by name: compare and details are stage 2", () => {
    const r = validateDocument(fixture("spec-20-3-plan-under-review.json"));
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => [p.pointer, p.stage])).toEqual([
      ["/view/0/t", 2],
      ["/view/2/t", 2],
    ]);
    expect(r.problems[0].message).toContain("`compare` is not available yet");
    expect(r.problems[1].message).toContain("`details` is not available yet");
  });

  it("20.2 is refused: go_ahead (and until) belong to stage 2", () => {
    const r = validateDocument(fixture("spec-20-2-go-ahead.json"));
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => [p.pointer, p.stage])).toEqual([
      ["/until", 2],
      ["/meanwhile", 2],
    ]);
    expect(r.problems.some((p) => p.message.includes("`go_ahead` is not available yet (planned for stage 2)"))).toBe(true);
  });

  it("20.4 is refused: canvas belongs to stage 3", () => {
    const r = validateDocument(fixture("spec-20-4-canvas.json"));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      expect.objectContaining({ pointer: "/view/t", stage: 3, message: expect.stringContaining("`canvas` is not available yet (planned for stage 3)") }),
      expect.objectContaining({ pointer: "/submit/label", stage: undefined }),
    ].slice(0, 1));
  });
});

describe("section 14 and 27.4: every rule has a failing fixture", () => {
  for (const c of INVALID_CASES) {
    it(`${c.rule}: ${c.name}`, () => {
      const doc = base();
      c.mutate(doc);
      const r = validateDocument(doc);
      expect(r.ok).toBe(false);
      const hit = r.problems.find((p) => p.pointer === c.pointer && p.message.includes(c.includes));
      expect(hit, JSON.stringify(r.problems)).toBeDefined();
    });
  }

  it("revises: a surface that does not exist", () => {
    const doc = base();
    doc.revises = "s_abc123";
    const r = validateDocument(doc, { resolveRevises: () => "missing" });
    expect(r.problems).toEqual([expect.objectContaining({ pointer: "/revises", message: expect.stringContaining("not a surface") })]);
  });

  it("revises: a surface of another agent or host", () => {
    const doc = base();
    doc.revises = "s_abc123";
    const r = validateDocument(doc, { resolveRevises: () => "foreign" });
    expect(r.problems).toEqual([expect.objectContaining({ pointer: "/revises", message: expect.stringContaining("another agent or host") })]);
  });

  it("revises: an own surface is accepted", () => {
    const doc = base();
    doc.revises = "s_abc123";
    expect(validateDocument(doc, { resolveRevises: () => "ok" }).ok).toBe(true);
  });

  it("reports every problem, not the first", () => {
    const doc = base();
    doc.v = 3;
    delete doc.context;
    doc.questions[0].recommend = "zz";
    doc.questions[1].of = "nope";
    doc.view[0].steps[0].ref = "bad";
    const r = validateDocument(doc);
    expect(r.problems.map((p) => p.pointer).sort()).toEqual(
      ["/context", "/questions/0/recommend", "/questions/1/of", "/v", "/view/0/steps/0/ref"].sort(),
    );
  });

  it("is not a document at all", () => {
    for (const v of [null, 3, [], "x"]) {
      expect(validateDocument(v).problems).toEqual([expect.objectContaining({ pointer: "" })]);
    }
  });

  it("escapes pointer tokens", () => {
    const doc = base();
    doc.questions[1].recommend = { "a/b~c": "do" };
    expect(validateDocument(doc).problems[0].pointer).toBe("/questions/1/recommend/a~1b~0c");
  });

  it("a review of a changes block cannot check item ids yet, and does not", () => {
    const doc = base();
    doc.view = [{ t: "changes" }];
    doc.questions[1].of = "changes";
    doc.questions[1].recommend = { f1: "do" };
    expect(validateDocument(doc).problems).toEqual([]);
  });

  it("accepts a changes block's commit and range forms", () => {
    for (const of of ["worktree", "HEAD~2", "a1b2c3d", "main..feature/x", "v1.0...v1.1"]) {
      const doc = base();
      doc.view.push({ t: "changes", of, paths: ["src/"] });
      expect(validateDocument(doc).problems, of).toEqual([]);
    }
  });

  it("accepts bare-title review items with derived ids", () => {
    const doc = base();
    doc.questions[1] = { id: "steps", kind: "review", prompt: "P", items: ["First", { id: "b", title: "Second" }], recommend: { i1: "approve" } };
    delete doc.view;
    expect(validateDocument(doc).problems).toEqual([]);
  });
});

describe("stage-2 and stage-3 fields are refused by name", () => {
  for (const c of STAGE_CASES) {
    it(c.name, () => {
      const doc = base();
      c.mutate(doc);
      const r = validateDocument(doc);
      expect(r.ok).toBe(false);
      const hit = r.problems.find((p) => p.pointer === c.pointer);
      expect(hit, JSON.stringify(r.problems)).toBeDefined();
      expect(hit?.stage).toBe(c.stage);
      expect(hit?.message).toContain(c.includes);
      expect(hit?.message).toContain(`stage ${c.stage}`);
    });
  }
});

describe("warnings (section 14)", () => {
  const warnings = (mutate: (d: Doc) => void): string[] => {
    const doc = base();
    mutate(doc);
    const r = validateDocument(doc);
    expect(r.problems).toEqual([]);
    return r.warnings.map((w) => w.pointer);
  };

  it("more than six questions", () => {
    expect(warnings((d) => { d.questions = Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, kind: "text", prompt: "P" })); })).toEqual(["/questions"]);
  });
  it("more than seven options", () => {
    expect(warnings((d) => { d.questions[0].options = Array.from({ length: 8 }, (_, i) => `o${i}`); delete d.questions[0].recommend; })).toEqual(["/questions/0/options"]);
  });
  it('a label containing "(Recommended)"', () => {
    expect(warnings((d) => { d.questions[0].options[0].label = "pg-boss (Recommended)"; })).toEqual(["/questions/0/options/0"]);
    expect(warnings((d) => { d.questions[0].label = "Queue (recommended)"; })).toEqual(["/questions/0/label"]);
  });
  it("a summary over 140 characters", () => {
    expect(warnings((d) => { d.summary = "x".repeat(141); })).toEqual(["/summary"]);
  });
  it("neither content nor questions", () => {
    expect(warnings((d) => { delete d.questions; delete d.view; delete d.context; })).toEqual([""]);
  });
  it("a surface with a view and no questions is a pure display, without a warning", () => {
    expect(warnings((d) => { delete d.questions; })).toEqual([]);
  });
  it("warnings come back with the problems", () => {
    const doc = base();
    doc.summary = "x".repeat(150);
    doc.v = 2;
    const r = validateDocument(doc);
    expect(r.ok).toBe(false);
    expect(r.warnings).toHaveLength(1);
  });
});

describe("object or JSON string (D6)", () => {
  const doc = fixture("spec-20-1-questions-only.json");

  it("accepts an object", () => expect(acceptDocument(doc).ok).toBe(true));
  it("accepts the same document as a string", () => {
    const r = acceptDocument(JSON.stringify(doc, null, 2));
    expect(r.ok).toBe(true);
    expect(r.document).toEqual(doc);
  });
  it("accepts a string with a byte-order mark and spaces", () => {
    expect(acceptDocument("﻿  " + JSON.stringify(doc) + "\n").ok).toBe(true);
  });
  it("reports malformed JSON as one problem", () => {
    const r = acceptDocument('{"v": 1,');
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].message).toContain("not valid JSON");
  });
  it("hints at a code fence", () => {
    expect(acceptDocument("```json\n{}\n```").problems[0].message).toContain("code fence");
  });
  it("refuses a doubly encoded string", () => {
    expect(acceptDocument(JSON.stringify(JSON.stringify(doc))).problems[0].message).toContain("encode the object once");
  });
  it("validates a string's content with the same pointers", () => {
    const bad = { ...doc, v: 2 };
    expect(acceptDocument(JSON.stringify(bad)).problems.map((p) => p.pointer)).toEqual(["/v"]);
  });
  it("measures a string's size from its text", () => {
    const big = JSON.stringify({ ...base(), view: ["x".repeat(256 * 1024)] });
    expect(acceptDocument(big).problems[0].message).toContain("256 KiB");
  });
  it("tool input wraps the document in `surface`", () => {
    expect(acceptToolInput({ surface: doc }).ok).toBe(true);
    expect(acceptToolInput({ surface: JSON.stringify(doc) }).ok).toBe(true);
  });
  it("tool input without `surface`, or with extras, is refused", () => {
    expect(acceptToolInput({}).problems[0].message).toContain("`surface` is required");
    expect(acceptToolInput(doc).ok).toBe(false);
    const r = acceptToolInput({ surface: doc, extra: 1 });
    expect(r.ok).toBe(false);
    expect(r.problems[0].message).toContain("`extra`");
  });
  it("formats every problem with its pointer", () => {
    const d = base();
    d.v = 2;
    delete d.context;
    const text = formatProblems(validateDocument(d));
    expect(text).toContain("2 problems");
    expect(text).toContain("- /v:");
    expect(text).toContain("- /context:");
  });
});

describe("ids and limits (27.1)", () => {
  it("surface ids", () => {
    expect(isSurfaceId("s_8f2k3a")).toBe(true);
    for (const bad of ["s_8f2k", "s_8F2K3A", "x_8f2k3a", "s_8f2k3ab", 5]) expect(isSurfaceId(bad)).toBe(false);
  });
  it("question, block and item ids", () => {
    expect(isItemId("s1")).toBe(true);
    expect(isItemId("f1h2")).toBe(true);
    expect(isItemId("a_b")).toBe(true);
    expect(isItemId("1a")).toBe(false);
    expect(isItemId("a.b")).toBe(false);
    expect(isItemId("A")).toBe(false);
    expect(isItemId("a".repeat(33))).toBe(false);
    expect(isItemId("a".repeat(32))).toBe(true);
  });
  it("option ids", () => {
    expect(isOptionId("pg-boss 16")).toBe(true);
    expect(isOptionId("a\nb")).toBe(false);
    expect(isOptionId("")).toBe(false);
    expect(isOptionId("x".repeat(65))).toBe(false);
  });
  it("generates unique surface ids and gives up when none is free", () => {
    let seed = 1;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newSurfaceId(random, (x) => taken.has(x));
      expect(isSurfaceId(id)).toBe(true);
      taken.add(id);
    }
    expect(taken.size).toBe(200);
    expect(() => newSurfaceId(random, () => true, 5)).toThrow();
  });
  it("message ids", () => expect(deliveryMessageId("s_8f2k3a", 2)).toBe("docket:s_8f2k3a:2"));
  it("counts UTF-8 bytes", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("€")).toBe(3);
    expect(utf8Bytes("😀")).toBe(4);
    expect(utf8Bytes("😀é€a")).toBe(Buffer.byteLength("😀é€a"));
  });
  it("clone helper keeps fixtures independent", () => {
    const a = base();
    const b = clone(a);
    b.v = 9;
    expect(a.v).toBe(1);
  });
});
