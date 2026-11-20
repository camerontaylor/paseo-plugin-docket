import { chmodSync, existsSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "../../shared/limits";
import { loadChanges } from "./changes";
import { readConfinedText } from "./confine";
import { runGit } from "./git";
import { commitAll, git, makeRepo, tempDir, write } from "./test-support";

const ctx = (cwd: string, limits: Partial<typeof LIMITS> = {}) => ({ cwd, git: runGit, readFile: readConfinedText, limits: { ...LIMITS, ...limits } });

describe("loadChanges: worktree", () => {
  it("shows edits, additions, deletions and untracked files with ids f1, f1h1", async () => {
    const dir = makeRepo({ "a.ts": "1\n2\n3\n", "b.ts": "x\n", "gone.ts": "bye\n" });
    write(dir, "a.ts", "1\n2 changed\n3\n");
    git(dir, "rm", "-q", "gone.ts");
    write(dir, "new file.ts", "fresh\n");
    write(dir, "ünï/çode.ts", "u\n");
    const r = await loadChanges({}, ctx(dir));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => [f.id, f.path, f.status])).toEqual([
      ["f1", "a.ts", "changed"],
      ["f2", "gone.ts", "removed"],
      ["f3", "new file.ts", "added"],
      ["f4", "ünï/çode.ts", "added"],
    ]);
    expect(r.files[0].hunks?.[0].id).toBe("f1h1");
    expect(r.content).toContain("2 changed");
    expect(r.content).toContain("fresh");
    expect(r.hash).toMatch(/^sha256:/);
    expect(r.commit).toBe(git(dir, "rev-parse", "HEAD"));
  });
  it("a clean worktree has no files", async () => {
    const dir = makeRepo();
    const r = await loadChanges({}, ctx(dir));
    expect(r).toMatchObject({ ok: true, files: [] });
  });
  it("ignores .gitignored files", async () => {
    const dir = makeRepo({ ".gitignore": "*.log\n", "a": "a\n" });
    write(dir, "x.log", "noise\n");
    const r = await loadChanges({}, ctx(dir));
    expect(r.ok && r.files).toEqual([]);
  });
  it("filters with paths, taking them literally", async () => {
    const dir = makeRepo({ "src/a.ts": "a\n", "src/b.ts": "b\n", "[x].ts": "k\n" });
    write(dir, "src/a.ts", "A\n");
    write(dir, "src/b.ts", "B\n");
    write(dir, "[x].ts", "K\n");
    const only = await loadChanges({ paths: ["src/a.ts"] }, ctx(dir));
    expect(only.ok && only.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    const lit = await loadChanges({ paths: ["[x].ts"] }, ctx(dir));
    expect(lit.ok && lit.files.map((f) => f.path)).toEqual(["[x].ts"]);
    const glob = await loadChanges({ paths: ["src/*.ts"] }, ctx(dir));
    expect(glob.ok && glob.files).toEqual([]);
  });
  it("paths filter applies to untracked files too", async () => {
    const dir = makeRepo();
    write(dir, "keep/n.ts", "n\n");
    write(dir, "skip/m.ts", "m\n");
    const r = await loadChanges({ paths: ["keep"] }, ctx(dir));
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["keep/n.ts"]);
  });
  it("shows a rename", async () => {
    const dir = makeRepo({ "old name.ts": "line one\nline two\nline three\nline four\n" });
    git(dir, "mv", "old name.ts", "new name.ts");
    const r = await loadChanges({}, ctx(dir));
    expect(r.ok && r.files.map((f) => [f.path, f.status])).toEqual([["new name.ts", "renamed"]]);
  });
  it("marks a binary file, with no hunks", async () => {
    const dir = makeRepo({ "p.bin": "x\n" });
    write(dir, "p.bin", Buffer.from([1, 0, 2, 0, 3]));
    write(dir, "q.bin", Buffer.from([9, 0, 9]));
    const r = await loadChanges({}, ctx(dir));
    expect(r.ok).toBe(true);
    if (r.ok) for (const f of r.files) expect(f.hunks ?? []).toEqual([]);
  });
  it("notes an untracked symlink instead of following it", async () => {
    const dir = makeRepo();
    const out = tempDir();
    write(out, "secret", "s3cret\n");
    symlinkSync(path.join(out, "secret"), path.join(dir, "evil"));
    const r = await loadChanges({}, ctx(dir));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).not.toContain("s3cret");
      expect(r.notes.join(" ")).toMatch(/evil/);
    }
  });
  it("works in an unborn repository (no commits yet)", async () => {
    const dir = tempDir("docket-unborn-");
    git(dir, "init", "-q", "-b", "main");
    write(dir, "n.ts", "n\n");
    git(dir, "add", "n.ts");
    write(dir, "u.ts", "u\n");
    const r = await loadChanges({}, ctx(dir));
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["n.ts", "u.ts"]);
  });
  it("is stable: reading twice gives the same hash, editing changes it", async () => {
    const dir = makeRepo({ "a": "1\n" });
    write(dir, "a", "2\n");
    const one = await loadChanges({}, ctx(dir));
    const two = await loadChanges({}, ctx(dir));
    write(dir, "a", "3\n");
    const three = await loadChanges({}, ctx(dir));
    expect(one.ok && two.ok && three.ok).toBe(true);
    if (one.ok && two.ok && three.ok) {
      expect(one.hash).toBe(two.hash);
      expect(three.hash).not.toBe(one.hash);
    }
  });
  it("works from a subdirectory, showing paths relative to it", async () => {
    const dir = makeRepo({ "pkg/a.ts": "a\n", "top.ts": "t\n" });
    write(dir, "pkg/a.ts", "A\n");
    write(dir, "top.ts", "T\n");
    const r = await loadChanges({}, ctx(path.join(dir, "pkg")));
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["a.ts"]);
  });
});

describe("loadChanges: commit and range", () => {
  function history() {
    const dir = makeRepo({ "a.ts": "1\n", "sp ace.ts": "s\n" });
    const c1 = git(dir, "rev-parse", "HEAD");
    write(dir, "a.ts", "2\n");
    write(dir, "ü.ts", "u\n");
    const c2 = commitAll(dir, "second");
    write(dir, "sp ace.ts", "s2\n");
    const c3 = commitAll(dir, "third");
    write(dir, "dirty.ts", "d\n"); // must not appear in a commit's changes
    return { dir, c1, c2, c3 };
  }
  it("a commit: what that commit changed", async () => {
    const { dir, c2 } = history();
    const r = await loadChanges({ of: c2 }, ctx(dir));
    expect(r.ok && r.files.map((f) => [f.path, f.status])).toEqual([["a.ts", "changed"], ["ü.ts", "added"]]);
    expect(r.ok && r.commit).toBe(c2);
  });
  it("a commit by name, HEAD", async () => {
    const { dir, c3 } = history();
    const r = await loadChanges({ of: "HEAD" }, ctx(dir));
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["sp ace.ts"]);
    expect(r.ok && r.commit).toBe(c3);
  });
  it("the root commit", async () => {
    const { dir, c1 } = history();
    const r = await loadChanges({ of: c1 }, ctx(dir));
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["a.ts", "sp ace.ts"]);
  });
  it("a two-dot range", async () => {
    const { dir, c1, c3 } = history();
    const r = await loadChanges({ of: `${c1}..${c3}` }, ctx(dir));
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["a.ts", "sp ace.ts", "ü.ts"]);
  });
  it("a three-dot range", async () => {
    const { dir, c1, c3 } = history();
    const r = await loadChanges({ of: `${c1}...${c3}` }, ctx(dir));
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["a.ts", "sp ace.ts", "ü.ts"]);
  });
  it("paths narrow a commit", async () => {
    const { dir, c2 } = history();
    const r = await loadChanges({ of: c2, paths: ["ü.ts"] }, ctx(dir));
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["ü.ts"]);
  });
  it("an unknown commit is refused with the reason", async () => {
    const { dir } = history();
    const r = await loadChanges({ of: "deadbeef".repeat(5) }, ctx(dir));
    expect(r).toMatchObject({ ok: false, reason: "unknown-commit" });
    const r2 = await loadChanges({ of: "nope..HEAD" }, ctx(dir));
    expect(r2).toMatchObject({ ok: false, reason: "unknown-commit" });
  });
  it("refuses an `of` that is an option or has odd syntax", async () => {
    const { dir } = history();
    for (const of of ["--output=/tmp/x", "-p", "HEAD --stat", "a\0b", "", "HEAD;ls", "$(id)"]) {
      const r = await loadChanges({ of }, ctx(dir));
      expect(r.ok, of).toBe(false);
    }
  });
  it("refuses bad paths: absolute, `..`, option-like", async () => {
    const { dir } = history();
    for (const p of ["/etc/passwd", "../x", "a/../../x", ""]) {
      const r = await loadChanges({ paths: [p] }, ctx(dir));
      expect(r, p).toMatchObject({ ok: false, reason: "bad-input" });
    }
    const r = await loadChanges({ paths: ["--output=/tmp/pwn"] }, ctx(dir));
    expect(existsSync("/tmp/pwn")).toBe(false);
    expect(r.ok && r.files).toEqual(r.ok ? [] : undefined);
  });
});

describe("loadChanges: refusals", () => {
  it("refuses outside a git repository", async () => {
    const dir = tempDir("docket-nogit-");
    write(dir, "a.ts", "a\n");
    expect(await loadChanges({}, ctx(dir))).toMatchObject({ ok: false, reason: "not-git" });
    expect(await loadChanges({ of: "HEAD" }, ctx(dir))).toMatchObject({ ok: false, reason: "not-git" });
  });
  it("refuses when git cannot be run", async () => {
    const dir = makeRepo();
    const r = await loadChanges({}, { ...ctx(dir), git: async () => ({ ok: false, reason: "no-git", message: "git is not installed", stderr: "" }) });
    expect(r).toMatchObject({ ok: false, reason: "no-git" });
  });
  it("refuses an untracked file over the size limit, saying which", async () => {
    const dir = makeRepo();
    write(dir, "huge.txt", "x".repeat(101));
    const r = await loadChanges({}, ctx(dir, { loadedFileBytes: 100 }));
    expect(r).toMatchObject({ ok: false, reason: "too-large" });
    if (!r.ok) expect(r.message).toMatch(/huge\.txt/);
  });
  it("refuses a tracked diff over the size limit", async () => {
    const dir = makeRepo({ "a": "1\n" });
    write(dir, "a", "y\n".repeat(200));
    const r = await loadChanges({}, ctx(dir, { loadedFileBytes: 100 }));
    expect(r).toMatchObject({ ok: false, reason: "too-large" });
  });
  it("at the real default, a 2 MiB + 1 untracked file is refused and one just under is accepted", async () => {
    const dir = makeRepo();
    write(dir, "ok.txt", "x".repeat(LIMITS.loadedFileBytes - 1024)); // the patch adds a few lines of its own
    expect((await loadChanges({}, ctx(dir))).ok).toBe(true);
    write(dir, "big.txt", "x".repeat(LIMITS.loadedFileBytes + 1));
    expect(await loadChanges({}, ctx(dir))).toMatchObject({ ok: false, reason: "too-large" });
  });
  it("cuts the list at the file limit with a note, keeping the first files in order", async () => {
    const dir = makeRepo();
    for (const n of ["e", "d", "c", "b", "a"]) write(dir, `${n}.ts`, `${n}\n`);
    const r = await loadChanges({}, ctx(dir, { changesFiles: 3 }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files.map((f) => f.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
      expect(r.notes.join(" ")).toMatch(/2 more changed files not shown.*limit is 3/);
    }
  });
  it("at the real default, 301 untracked files are cut to 300 with a note", async () => {
    const dir = makeRepo();
    for (let i = 0; i < LIMITS.changesFiles + 1; i++) write(dir, `f/${String(i).padStart(4, "0")}.txt`, "x\n");
    const r = await loadChanges({}, ctx(dir));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toHaveLength(LIMITS.changesFiles);
      expect(r.notes.join(" ")).toMatch(/1 more changed file not shown/);
    }
  }, 30_000);
  it("an aborted signal stops it", async () => {
    const dir = makeRepo();
    const ac = new AbortController();
    ac.abort();
    const r = await loadChanges({}, { ...ctx(dir), signal: ac.signal });
    expect(r.ok).toBe(false);
  });
});

describe("loadChanges: sections and totals", () => {
  it("keeps every file's patch when one file changes kind (file to link) and another is edited", async () => {
    const dir = makeRepo({ "a.txt": "1\n2\n3\n", "b.txt": "x\n", "c.txt": "p\nq\n" });
    write(dir, "a.txt", "1\n2 edited\n3\n");
    rmSync(path.join(dir, "b.txt"));
    symlinkSync("a.txt", path.join(dir, "b.txt"));
    write(dir, "c.txt", "p\nq\nr\n");
    const r = await loadChanges({}, ctx(dir));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toContain("2 edited");
    expect(r.content).toContain("+r");
    expect(r.files.find((f) => f.path === "a.txt")?.hunks?.length).toBe(1);
    expect(r.files.find((f) => f.path === "c.txt")?.hunks?.length).toBe(1);
  });
  it("stops as soon as untracked patches add up past the limit, naming the narrowing", async () => {
    const dir = makeRepo();
    for (let i = 0; i < 8; i++) write(dir, `u${i}.txt`, `${"line\n".repeat(150)}`);
    const readFile = vi.fn(readConfinedText);
    const r = await loadChanges({}, { ...ctx(dir, { loadedFileBytes: 2000 }), readFile });
    expect(r).toMatchObject({ ok: false, reason: "too-large" });
    expect(readFile).toHaveBeenCalledTimes(3);
  });
  it("keeps patches for filenames that Git quotes", async () => {
    const names = ['a"b.txt', "c\\d.txt", "e\tf.txt", "g\nh.txt"];
    const dir = makeRepo(Object.fromEntries(names.map((name) => [name, "before\n"])));
    for (const name of names) write(dir, name, "after\n");
    const result = await loadChanges({}, ctx(dir));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.files.map((file) => file.path)).toEqual(names);
    expect(result.files.every((file) => file.hunks?.length === 1)).toBe(true);
  });

  it("reads changes from a split index", async () => {
    const dir = makeRepo({ "a.txt": "before\n" });
    git(dir, "update-index", "--split-index");
    expect(git(dir, "rev-parse", "--shared-index-path")).toContain("sharedindex.");
    write(dir, "a.txt", "after\n");
    const result = await loadChanges({}, ctx(dir));
    expect(result).toMatchObject({ ok: true, files: [{ path: "a.txt", status: "changed" }] });
  });

  it("honors core.filemode=false for tracked files", async () => {
    const dir = makeRepo({ "a.txt": "before\n" });
    git(dir, "config", "core.filemode", "false");
    chmodSync(path.join(dir, "a.txt"), 0o755);
    expect(await loadChanges({}, ctx(dir))).toMatchObject({ ok: true, files: [] });
  });

  it.each(["true", "input"])("normalizes CRLF with core.autocrlf=%s", async (setting) => {
    const dir = makeRepo({ "text.txt": "first\nsecond\n" });
    git(dir, "config", "core.autocrlf", setting);
    write(dir, "text.txt", "first\r\nsecond\r\n");
    expect(git(dir, "diff", "--name-only", "HEAD")).toBe("");
    expect(await loadChanges({}, ctx(dir))).toMatchObject({ ok: true, files: [] });

    write(dir, "text.txt", "first\r\nchanged\r\n");
    const result = await loadChanges({}, ctx(dir));
    expect(result).toMatchObject({ ok: true, files: [{ path: "text.txt", added: 1, removed: 1 }] });
  });

  it("truncates commit patches when a file and a directory trade places", async () => {
    const dir = makeRepo({ "section": "previous content\n" });
    rmSync(path.join(dir, "section"));
    write(dir, "section/a.txt", "first file\n");
    write(dir, "section/b.txt", "second file\n");
    const expanded = commitAll(dir, "expand section");
    git(dir, "rm", "-qr", "--", "section");
    write(dir, "section", "replacement content\n");
    const collapsed = commitAll(dir, "collapse section");

    for (const [commit, parentStatus, childStatus] of [
      [expanded, "removed", "added"],
      [collapsed, "added", "removed"],
    ]) {
      const result = await loadChanges({ of: commit }, ctx(dir, { changesFiles: 2 }));
      expect(result).toMatchObject({
        ok: true,
        files: [{ path: "section", status: parentStatus }, { path: "section/a.txt", status: childStatus }],
        notes: [expect.stringContaining("1 more changed file not shown")],
      });
      if (result.ok) expect(result.content).not.toContain("section/b.txt");
    }
  });

  it("works in a SHA-256 repository, including a first commit", async () => {
    const dir = tempDir("docket-sha256-");
    git(dir, "init", "-q", "-b", "main", "--object-format=sha256");
    write(dir, "a.txt", "1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "first");
    write(dir, "a.txt", "2\n");
    const first = await loadChanges({}, ctx(dir));
    expect(first.ok && first.files.map((f) => f.path)).toEqual(["a.txt"]);
    const root = await loadChanges({ of: "HEAD" }, ctx(dir));
    expect(root.ok && root.files.map((f) => f.path)).toEqual(["a.txt"]);
  });
});
