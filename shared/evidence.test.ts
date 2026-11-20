import { describe, expect, it } from "vitest";
import type { SurfaceDocument } from "./document";
import {
  addedFilePatch,
  buildChanges,
  capChanges,
  changesPathProblem,
  codeExcerpt,
  collectRefs,
  compareHash,
  evidenceBudgetProblem,
  hunkHeaders,
  itemSizeProblem,
  joinChanges,
  parseNameStatusZ,
  parseNumstatZ,
  parseRef,
  pathSyntaxProblem,
  refExcerpt,
  refsInMarkdown,
  splitLines,
  splitPatch,
} from "./evidence";
import { LIMITS } from "./limits";

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n") + "\n";

describe("paths", () => {
  it("refuses a path on its text alone", () => {
    expect(pathSyntaxProblem("")).toMatch(/empty/);
    expect(pathSyntaxProblem("a\0b")).toMatch(/NUL/);
    expect(pathSyntaxProblem("../x")).toMatch(/\.\./);
    expect(pathSyntaxProblem("a/../b")).toMatch(/\.\./);
    expect(pathSyntaxProblem("a\\..\\b")).toMatch(/\.\./);
    expect(pathSyntaxProblem("a/..")).toMatch(/\.\./);
    expect(pathSyntaxProblem("src/a..b/c.ts")).toBeNull();
    expect(pathSyntaxProblem("src/mail send/é.ts")).toBeNull();
  });
  it("changes paths are relative", () => {
    expect(changesPathProblem("/etc")).toMatch(/absolute/);
    expect(changesPathProblem("\\x")).toMatch(/absolute/);
    expect(changesPathProblem("C:\\x")).toMatch(/absolute/);
    expect(changesPathProblem("..")).toMatch(/\.\./);
    expect(changesPathProblem("src")).toBeNull();
  });
});

describe("excerpts", () => {
  it("counts lines as a reader does", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
  });
  it("code: the first 200 lines without from/to", () => {
    const r = codeExcerpt(lines(500), undefined, undefined);
    expect(r).toMatchObject({ ok: true, from: 1, to: 200, totalLines: 500 });
  });
  it("code: from..to, to clipped to the file, from past the end refused", () => {
    expect(codeExcerpt(lines(10), 3, 5)).toMatchObject({ ok: true, text: "l3\nl4\nl5", from: 3, to: 5 });
    expect(codeExcerpt(lines(10), 8, 99)).toMatchObject({ ok: true, from: 8, to: 10 });
    expect(codeExcerpt(lines(10), 5, undefined)).toMatchObject({ ok: true, from: 5, to: 10 });
    expect(codeExcerpt(lines(10), 11, 12)).toMatchObject({ ok: false });
    expect(codeExcerpt("", undefined, undefined)).toMatchObject({ ok: true, text: "", totalLines: 0 });
  });
  it("ref: a line gets three lines of context each side, clipped at the ends", () => {
    expect(refExcerpt(lines(20), 10, 10)).toMatchObject({ from: 7, to: 13 });
    expect(refExcerpt(lines(20), 1, 1)).toMatchObject({ from: 1, to: 4 });
    expect(refExcerpt(lines(20), 19, 19)).toMatchObject({ from: 16, to: 20 });
    expect(refExcerpt(lines(20), 30, 30)).toMatchObject({ ok: false });
  });
  it("ref: a range as written, at most 200 lines", () => {
    expect(refExcerpt(lines(20), 4, 6)).toMatchObject({ from: 4, to: 6 });
    expect(refExcerpt(lines(900), 10, 800)).toMatchObject({ from: 10, to: 209 });
  });
  it("parses refs", () => {
    expect(parseRef("src/a.ts:40")).toEqual({ path: "src/a.ts", from: 40, to: 40 });
    expect(parseRef("src/a b/é.ts:4-9")).toEqual({ path: "src/a b/é.ts", from: 4, to: 9 });
    expect(parseRef("a.ts:0")).toBeNull();
    expect(parseRef("a.ts:9-4")).toBeNull();
    expect(parseRef("a.ts")).toBeNull();
  });
});

describe("refs in a document", () => {
  it("finds inline-code refs in prose, not URLs or bare words", () => {
    expect(refsInMarkdown("see `src/a.ts:4` and `https://x.y:80` and `foo:12` and `a.ts:3-5`")).toEqual(["src/a.ts:4", "a.ts:3-5"]);
  });
  it("collects structured refs strictly and prose refs leniently, each once", () => {
    const doc: SurfaceDocument = {
      v: 1,
      summary: "s",
      context: "look at `ctx/a.ts:1`",
      view: [
        "text `md/b.ts:2`",
        { t: "plan", steps: [{ id: "s1", title: "t", ref: "p/c.ts:3", files: ["p/c.ts:3", "plain/file.ts", "p/d.ts:5-9"], detail: "`det/e.ts:7`", children: [{ id: "s2", title: "u", ref: "p/f.ts:1" }] }] },
      ],
      questions: [{ id: "r", kind: "review", prompt: "p", items: ["bare", { id: "a", title: "A", ref: "q/g.ts:8" }] }],
    };
    const found = collectRefs(doc);
    expect(found.map((f) => [f.ref, f.lenient])).toEqual([
      ["ctx/a.ts:1", true],
      ["md/b.ts:2", true],
      ["p/c.ts:3", false],
      ["p/d.ts:5-9", false],
      ["det/e.ts:7", true],
      ["p/f.ts:1", false],
      ["q/g.ts:8", false],
    ]);
  });
});

describe("limits and comparison", () => {
  it("one file is refused over 2 MiB with the numbers", () => {
    expect(itemSizeProblem("a.ts", LIMITS.loadedFileBytes)).toBeNull();
    expect(itemSizeProblem("a.ts", LIMITS.loadedFileBytes + 1)).toMatch(/2097153 bytes.*2 MiB/);
  });
  it("one surface is refused over 20 MiB", () => {
    expect(evidenceBudgetProblem(LIMITS.evidenceBytes - 5, 5)).toBeNull();
    expect(evidenceBudgetProblem(LIMITS.evidenceBytes - 5, 6)).toMatch(/20 MiB/);
  });
  it("compares hashes", () => {
    expect(compareHash("sha256:a", "sha256:a")).toBe("same");
    expect(compareHash("sha256:a", "sha256:b")).toBe("changed");
    expect(compareHash("sha256:a", null)).toBe("gone");
  });
  it("the budget is 20 s", () => expect(LIMITS.evidenceBudgetMs).toBe(20_000));
});

describe("git output", () => {
  it("parses name-status -z, renames and odd paths included", () => {
    const out = "M\0src/a b.ts\0A\0é/ü.ts\0D\0gone.ts\0R087\0old.ts\0new.ts\0T\0t\0";
    expect(parseNameStatusZ(out)).toEqual([
      { path: "src/a b.ts", status: "changed" },
      { path: "é/ü.ts", status: "added" },
      { path: "gone.ts", status: "removed" },
      { path: "new.ts", oldPath: "old.ts", status: "renamed" },
      { path: "t", status: "changed" },
    ]);
    expect(parseNameStatusZ("")).toEqual([]);
  });
  it("parses numstat -z", () => {
    const out = "12\t4\tsrc/a b.ts\0-\t-\timg.png\0" + "3\t1\t\0old.ts\0new.ts\0";
    expect(parseNumstatZ(out)).toEqual([
      { path: "src/a b.ts", added: 12, removed: 4, binary: false },
      { path: "img.png", added: 0, removed: 0, binary: true },
      { path: "new.ts", added: 3, removed: 1, binary: false },
    ]);
  });
  it("joins the two, and refuses a mismatch", () => {
    const ns = "M\0a.ts\0R100\0o.ts\0n.ts\0";
    const nu = "1\t2\ta.ts\0" + "0\t0\t\0o.ts\0n.ts\0";
    expect(joinChanges(ns, nu)).toEqual([
      { path: "a.ts", status: "changed", added: 1, removed: 2, binary: false },
      { path: "n.ts", oldPath: "o.ts", status: "renamed", added: 0, removed: 0, binary: false },
    ]);
    expect(joinChanges(ns, "1\t2\ta.ts\0")).toBeNull();
    expect(joinChanges("M\0a.ts\0", "1\t2\tb.ts\0")).toBeNull();
  });
  it("splits a patch by file and finds hunk headers", () => {
    const patch =
      "diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n@@ -9,2 +9,3 @@ fn\n ctx\n+@@ not a header\n" +
      "diff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n";
    const pieces = splitPatch(patch);
    expect(pieces).toHaveLength(2);
    expect(hunkHeaders(pieces[0])).toEqual(["@@ -1 +1 @@", "@@ -9,2 +9,3 @@ fn"]);
    expect(hunkHeaders(pieces[1])).toEqual([]);
    expect(splitPatch("")).toEqual([]);
    expect(pieces.join("")).toBe(patch);
  });
  it("writes the patch of an untracked file", () => {
    expect(addedFilePatch("n.ts", "a\nb\n", false)).toBe("diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(addedFilePatch("n.ts", "a", true)).toContain("\\ No newline at end of file");
    expect(addedFilePatch("e", "", false)).toBe("diff --git a/e b/e\nnew file mode 100644\n");
  });
  it("gives ids f1, f1h1 in display order", () => {
    const e = (path: string, hunks: string[]) => ({ path, status: "changed" as const, added: 1, removed: 0, hunks });
    const built = buildChanges([e("b.ts", ["@@ 1", "@@ 2"]), e("a.ts", ["@@ 3"]), e("c.ts", [])]);
    expect(built.files.map((f) => [f.id, f.path, f.hunks?.map((h) => h.id)])).toEqual([
      ["f1", "a.ts", ["f1h1"]],
      ["f2", "b.ts", ["f2h1", "f2h2"]],
      ["f3", "c.ts", []],
    ]);
    expect(built.omitted).toBe(0);
  });
  it("cuts at the limit with a note", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.ts` }));
    const r = capChanges(many, { changesFiles: 3 });
    expect(r.kept).toHaveLength(3);
    expect(r.omitted).toBe(2);
    expect(r.notes[0]).toMatch(/2 more changed files not shown.*limit is 3/);
    expect(capChanges(many, { changesFiles: 5 }).notes).toEqual([]);
    expect(capChanges(many.slice(0, 1), { changesFiles: 0 }).notes[0]).toMatch(/1 more changed file not shown/);
  });
});
