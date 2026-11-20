import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SurfaceDocument } from "../../shared/document";
import { LIMITS } from "../../shared/limits";
import type { FileReader } from "./confine";
import { loadEvidence } from "./load";
import { makeRepo, tempDir, write } from "./test-support";

const doc = (view: SurfaceDocument["view"], extra: Partial<SurfaceDocument> = {}): SurfaceDocument => ({ v: 1, summary: "s", view, ...extra });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

describe("code blocks", () => {
  it("keeps the excerpt with hash, commit, size and the file's own hash", async () => {
    const dir = makeRepo({ "src/a b/é.ts": lines(10) });
    const r = await loadEvidence(doc({ t: "code", id: "c", file: "src/a b/é.ts", from: 3, to: 4 }), { cwd: dir, now: () => new Date("2026-11-21T00:00:00Z") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const meta = r.evidence.snapshots["1"];
    expect(meta).toMatchObject({ kind: "file", path: "src/a b/é.ts", from: 3, to: 4, block: "c", readAt: "2026-11-21T00:00:00.000Z" });
    expect(meta.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta.fileHash).toMatch(/^sha256:/);
    expect(meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.bytes).toBe(Buffer.byteLength("line 3\nline 4"));
    expect(r.evidence.contents["1"]).toBe("line 3\nline 4");
    expect(r.evidence.render.code?.c).toBe("line 3\nline 4");
    expect(r.evidence.byBlock.c).toBe("1");
  });
  it("works in a folder that is not a git repository, with no commit recorded", async () => {
    const dir = tempDir();
    write(dir, "a.ts", "x\n");
    const r = await loadEvidence(doc({ t: "code", file: "a.ts" }), { cwd: dir });
    expect(r.ok && r.evidence.snapshots["1"].commit).toBeUndefined();
  });
  it("a code block without `file` needs nothing loaded", async () => {
    const r = await loadEvidence(doc({ t: "code", s: "inline" }), { cwd: tempDir() });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && Object.keys(r.evidence.snapshots)).toEqual([]);
  });
  it("refuses with the reason: missing, outside, `..`, absolute, binary, too large, from past the end", async () => {
    const dir = makeRepo({ "a.ts": lines(5) });
    const out = tempDir();
    write(out, "s.txt", "s\n");
    symlinkSync(path.join(out, "s.txt"), path.join(dir, "lnk"));
    mkdirSync(path.join(dir, "d"));
    symlinkSync(out, path.join(dir, "d", "up"));
    write(dir, "bin", Buffer.from([0, 1, 2]));
    write(dir, "big", "x".repeat(LIMITS.loadedFileBytes + 1));
    const cases: [string, string, number?][] = [
      ["nope.ts", "missing"],
      ["lnk", "outside"],
      ["d/up/s.txt", "outside"],
      [path.join(out, "s.txt"), "outside"],
      ["../x", "bad-input"],
      ["a/../a.ts", "bad-input"],
      ["bin", "unreadable"],
      ["big", "too-large"],
      ["a.ts", "bad-input", 99],
    ];
    for (const [file, reason, from] of cases) {
      const r = await loadEvidence(doc({ t: "code", file, from }), { cwd: dir });
      expect(r.ok, file).toBe(false);
      if (!r.ok) {
        expect(r.reason, file).toBe(reason);
        expect(r.message.length).toBeGreaterThan(10);
        expect(r.problems[0].pointer).toMatch(/^\/view/);
      }
    }
  });
  it("reports every problem, pointing into the document", async () => {
    const dir = makeRepo({ "a.ts": "a\n" });
    const r = await loadEvidence(doc([{ t: "code", file: "a.ts" }, { t: "code", id: "x", file: "m1" }, { t: "code", id: "y", file: "m2" }]), { cwd: dir });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems.map((p) => p.pointer)).toEqual(["/view/1/file", "/view/2/file"]);
      expect(r.message).toMatch(/and 1 more/);
    }
  });
  it("reads from an extra folder the agent may read", async () => {
    const dir = makeRepo();
    const extra = tempDir();
    write(extra, "n.md", "notes\n");
    const file = path.join(extra, "n.md");
    expect((await loadEvidence(doc({ t: "code", file }), { cwd: dir })).ok).toBe(false);
    expect((await loadEvidence(doc({ t: "code", file }), { cwd: dir, extraRoots: [extra] })).ok).toBe(true);
  });
});

describe("changes blocks", () => {
  it("keeps a snapshot and the files to render, with ids", async () => {
    const dir = makeRepo({ "a.ts": "1\n" });
    write(dir, "a.ts", "2\n");
    write(dir, "new.ts", "n\n");
    const r = await loadEvidence(doc({ t: "changes", id: "ch" }), { cwd: dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.evidence.render.changes?.ch.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(r.evidence.snapshots["1"]).toMatchObject({ kind: "changes", of: "worktree", block: "ch" });
    expect(r.evidence.snapshots["1"].commit).toMatch(/^[0-9a-f]{40}$/);
  });
  it("is refused outside a git repository, with the reason and the alternative", async () => {
    const dir = tempDir("docket-nogit-");
    write(dir, "a.ts", "x\n");
    const r = await loadEvidence(doc([{ t: "code", file: "a.ts" }, { t: "changes" }]), { cwd: dir });
    expect(r).toMatchObject({ ok: false, reason: "not-git" });
    if (!r.ok) {
      expect(r.message).toMatch(/not inside a git repository/);
      expect(r.problems[0].pointer).toBe("/view/1");
    }
  });
  it("is refused when the commit is unknown", async () => {
    const dir = makeRepo();
    const r = await loadEvidence(doc({ t: "changes", of: "0123456789abcdef0123456789abcdef01234567" }), { cwd: dir });
    expect(r).toMatchObject({ ok: false, reason: "unknown-commit" });
  });
  it("is refused when the diff is over the size limit", async () => {
    const dir = makeRepo();
    write(dir, "n.txt", "x\n".repeat(500));
    const r = await loadEvidence(doc({ t: "changes" }), { cwd: dir, limits: { loadedFileBytes: 200 } });
    expect(r).toMatchObject({ ok: false, reason: "too-large" });
  });
  it("cuts a long list at the file limit with a warning, not a refusal", async () => {
    const dir = makeRepo();
    for (let i = 0; i < 6; i++) write(dir, `f${i}.txt`, "x\n");
    const r = await loadEvidence(doc({ t: "changes", id: "ch" }), { cwd: dir, limits: { changesFiles: 4 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evidence.render.changes?.ch).toHaveLength(4);
      expect(r.evidence.warnings.join(" ")).toMatch(/2 more changed files not shown/);
    }
  });
});

describe("refs", () => {
  it("keeps an excerpt for a structured ref, with context lines", async () => {
    const dir = makeRepo({ "src/a.ts": lines(30) });
    const r = await loadEvidence(
      doc("text", { questions: [{ id: "r", kind: "review", prompt: "p", items: [{ id: "a", title: "A", ref: "src/a.ts:10" }] }] }),
      { cwd: dir },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const n = r.evidence.byRef["src/a.ts:10"];
      expect(r.evidence.snapshots[n]).toMatchObject({ kind: "file", path: "src/a.ts", from: 7, to: 13, ref: "src/a.ts:10" });
    }
  });
  it("refuses a structured ref that leads outside, but only warns about a missing file or prose", async () => {
    const dir = makeRepo({ "a.ts": lines(3) });
    const out = tempDir();
    write(out, "s.txt", "s\n");
    symlinkSync(path.join(out, "s.txt"), path.join(dir, "lnk"));
    symlinkSync(path.join(out, "s.txt"), path.join(dir, "lnk.txt"));
    const review = (ref: string): SurfaceDocument =>
      doc("t", { questions: [{ id: "r", kind: "review", prompt: "p", items: [{ id: "a", title: "A", ref }] }] });
    expect(await loadEvidence(review("lnk:1"), { cwd: dir })).toMatchObject({ ok: false, reason: "outside" });
    const missing = await loadEvidence(review("later.ts:1"), { cwd: dir });
    expect(missing.ok && missing.evidence.warnings.join(" ")).toMatch(/later\.ts/);
    const beyond = await loadEvidence(review("a.ts:900"), { cwd: dir });
    expect(beyond.ok && beyond.evidence.warnings.length).toBeGreaterThan(0);
    const prose = await loadEvidence(doc("see `lnk.txt:1` and `nothere.ts:2`"), { cwd: dir });
    expect(prose.ok && prose.evidence.warnings).toHaveLength(2);
  });
  it("a ref written in prose and again as a structured ref is still refused when it leads outside", async () => {
    const dir = makeRepo({ "a.ts": lines(3) });
    const out = tempDir();
    write(out, "s.txt", "s\n");
    symlinkSync(path.join(out, "s.txt"), path.join(dir, "lnk.txt"));
    const item = { id: "a", title: "A", ref: "lnk.txt:1" };
    const questions: SurfaceDocument["questions"] = [{ id: "r", kind: "review", prompt: "p", items: [item] }];
    const proseFirst = await loadEvidence(doc("see `lnk.txt:1`", { questions }), { cwd: dir });
    expect(proseFirst).toMatchObject({ ok: false, reason: "outside" });
    if (!proseFirst.ok) expect(proseFirst.problems[0].pointer).toBe("/questions/0/items/0/ref");
    const planFirst = await loadEvidence(doc([{ t: "plan", steps: [{ id: "s1", title: "t", ref: "lnk.txt:1" }] }, "see `lnk.txt:1`"]), { cwd: dir });
    expect(planFirst).toMatchObject({ ok: false, reason: "outside" });
    // and a missing file written both ways stays a warning
    const missing = await loadEvidence(doc("see `new.ts:1`", { questions: [{ id: "r", kind: "review", prompt: "p", items: [{ id: "a", title: "A", ref: "new.ts:1" }] }] }), { cwd: dir });
    expect(missing.ok).toBe(true);
  });
  it("reads each distinct ref once", async () => {
    const dir = makeRepo({ "a.ts": lines(30) });
    const r = await loadEvidence(doc("`a.ts:5` and `a.ts:5` and `a.ts:20`"), { cwd: dir });
    expect(r.ok && Object.keys(r.evidence.byRef)).toEqual(["a.ts:5", "a.ts:20"]);
  });
});

describe("limits for one show", () => {
  it("refuses when all snapshots together pass the evidence limit", async () => {
    const dir = makeRepo({ "a.ts": "x".repeat(60) + "\n", "b.ts": "y".repeat(60) + "\n" });
    const view: SurfaceDocument["view"] = [{ t: "code", id: "a", file: "a.ts" }, { t: "code", id: "b", file: "b.ts" }];
    const ok = await loadEvidence(doc(view), { cwd: dir, limits: { evidenceBytes: 200 } });
    expect(ok.ok).toBe(true);
    const r = await loadEvidence(doc(view), { cwd: dir, limits: { evidenceBytes: 100 } });
    expect(r).toMatchObject({ ok: false, reason: "evidence-too-large" });
    if (!r.ok) expect(r.message).toMatch(/20 MiB|bytes/);
  });
  it("at the real defaults, ten 2 MiB files are over 20 MiB", async () => {
    const dir = makeRepo();
    const body = ("x".repeat(99) + "\n").repeat(Math.floor(LIMITS.loadedFileBytes / 100));
    write(dir, "big.txt", body);
    const blocks = Array.from({ length: 11 }, (_, i) => ({ t: "code" as const, id: `b${i}`, file: "big.txt", from: 1, to: 20_000 }));
    const r = await loadEvidence(doc(blocks), { cwd: dir, limits: { excerptLines: 20_000 } });
    expect(r).toMatchObject({ ok: false, reason: "evidence-too-large" });
  }, 30_000);
});

describe("the loading budget", () => {
  const slow: FileReader = (_p, o) =>
    new Promise((resolve) => {
      o.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "error", message: "aborted" }));
    });
  const never: FileReader = () => new Promise(() => {});

  it("is 20 seconds by default", () => expect(LIMITS.evidenceBudgetMs).toBe(20_000));

  it("refuses a show whose reader is too slow, with the reason and what to do", async () => {
    const dir = makeRepo({ "a.ts": "x\n" });
    const t0 = Date.now();
    const r = await loadEvidence(doc({ t: "code", file: "a.ts" }), { cwd: dir, readFile: never, budgetMs: 150 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    if (!r.ok) expect(r.message).toMatch(/took more than .* seconds/);
  });
  it("the budget is shared: several slowish reads add up", async () => {
    const dir = makeRepo({ "a.ts": "x\n" });
    const each: FileReader = async (p, o) => {
      await new Promise((r) => setTimeout(r, 80));
      const { readConfinedText } = await import("./confine");
      return readConfinedText(p, o);
    };
    const view: SurfaceDocument["view"] = Array.from({ length: 5 }, (_, i) => ({ t: "code" as const, id: `c${i}`, file: "a.ts" }));
    expect((await loadEvidence(doc(view), { cwd: dir, readFile: each, budgetMs: 5000 })).ok).toBe(true);
    expect(await loadEvidence(doc(view), { cwd: dir, readFile: each, budgetMs: 200 })).toMatchObject({ ok: false, reason: "timeout" });
  });
  it("aborts the reader's signal when time is up", async () => {
    const dir = makeRepo({ "a.ts": "x\n" });
    let aborted = false;
    const watch: FileReader = (_p, o) =>
      new Promise(() => {
        o.signal?.addEventListener("abort", () => (aborted = true));
      });
    await loadEvidence(doc({ t: "code", file: "a.ts" }), { cwd: dir, readFile: watch, budgetMs: 100 });
    expect(aborted).toBe(true);
  });
  it("a slow git is stopped too", async () => {
    const dir = makeRepo();
    const slowGit = () => new Promise<never>(() => {});
    const r = await loadEvidence(doc({ t: "changes" }), { cwd: dir, git: slowGit, budgetMs: 100 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });
  it("a slow ref read counts against the same budget", async () => {
    const dir = makeRepo({ "a.ts": "x\n" });
    const r = await loadEvidence(doc("see `a.ts:1`"), { cwd: dir, readFile: slow, budgetMs: 100 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });
  it("leaves no timer running after a quick load", async () => {
    const dir = makeRepo({ "a.ts": "x\n" });
    vi.useFakeTimers();
    try {
      const r = await loadEvidence(doc({ t: "code", file: "a.ts" }), { cwd: dir, budgetMs: 60_000 });
      expect(r.ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
