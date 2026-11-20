import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../shared/limits";
import { loadChanges } from "./changes";
import { readConfinedText } from "./confine";
import { runGit } from "./git";
import { git, makeRepo, tempDir, write } from "./test-support";

describe("runGit is read-only", () => {
  it("throws for every subcommand outside the allowlist", async () => {
    const dir = makeRepo();
    for (const sub of ["commit", "checkout", "add", "reset", "clean", "config", "fetch", "push", "gc", "stash", "apply", "update-index", "status", "log", "show"]) {
      expect(() => runGit(dir, [sub], { maxBytes: 100 }), sub).toThrow();
    }
    expect(() => runGit(dir, [], { maxBytes: 100 })).toThrow();
  });
  it("answers an allowed subcommand and caps output", async () => {
    const dir = makeRepo();
    const ok = await runGit(dir, ["rev-parse", "HEAD"], { maxBytes: 100 });
    expect(ok).toMatchObject({ ok: true });
    const big = await runGit(dir, ["rev-parse", "HEAD"], { maxBytes: 5 });
    expect(big).toMatchObject({ ok: false, reason: "too-large" });
  });
  it("reports a cancelled run", async () => {
    const dir = makeRepo();
    const ac = new AbortController();
    ac.abort();
    expect(await runGit(dir, ["rev-parse", "HEAD"], { maxBytes: 100, signal: ac.signal })).toMatchObject({ ok: false, reason: "cancelled" });
  });
});

describe("a hostile repository's configuration never runs", () => {
  it("runs no hook, fsmonitor, external diff, textconv, pager or filter", async () => {
    const dir = makeRepo({ "a.txt": "1\n", "b.bin": "x\n" });
    const marks = tempDir("docket-marks-");
    const script = (name: string, body = "") => {
      const p = write(marks, name + ".sh", `#!/bin/sh\ntouch "${marks}/${name}.ran"\n${body}`);
      chmodSync(p, 0o755);
      return p;
    };
    const hookDir = path.join(dir, ".git", "hooks");
    for (const h of ["pre-commit", "post-checkout", "post-index-change", "reference-transaction", "post-merge"]) {
      const p = write(hookDir, h, `#!/bin/sh\ntouch "${marks}/hook-${h}.ran"\n`);
      chmodSync(p, 0o755);
    }
    git(dir, "config", "core.fsmonitor", script("fsmonitor", "echo\n"));
    git(dir, "config", "core.pager", script("pager", "cat\n"));
    git(dir, "config", "core.hooksPath", hookDir);
    git(dir, "config", "diff.external", script("external"));
    git(dir, "config", "diff.evil.textconv", script("textconv", 'cat "$1"\n'));
    git(dir, "config", "filter.evil.clean", script("filter"));
    git(dir, "config", "core.editor", script("editor"));
    write(dir, ".gitattributes", "*.txt diff=evil\n*.bin diff=evil filter=evil\n");
    write(dir, "a.txt", "2\n");
    write(dir, "b.bin", "y\n");
    write(dir, "new.txt", "n\n");

    const r = await loadChanges({}, { cwd: dir, git: runGit, readFile: readConfinedText, limits: LIMITS });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("-1");
    for (const n of ["fsmonitor", "pager", "external", "textconv", "filter", "editor", "hook-pre-commit", "hook-post-checkout", "hook-post-index-change", "hook-reference-transaction", "hook-post-merge"]) {
      expect(existsSync(path.join(marks, `${n}.ran`)), n).toBe(false);
    }
  });
  it("does not read the user's global config or take locks that change the repo", async () => {
    const dir = makeRepo({ "a": "1\n" });
    write(dir, "a", "2\n");
    const before = git(dir, "rev-parse", "HEAD");
    const idx = git(dir, "ls-files", "--stage");
    await loadChanges({}, { cwd: dir, git: runGit, readFile: readConfinedText, limits: LIMITS });
    expect(git(dir, "rev-parse", "HEAD")).toBe(before);
    expect(git(dir, "ls-files", "--stage")).toBe(idx);
    expect(git(dir, "status", "--porcelain")).toBe("M a");
    expect(existsSync(path.join(dir, ".git", "index.lock"))).toBe(false);
  });
  it("a path that looks like an option is a literal pathspec, not a flag", async () => {
    const dir = makeRepo({ "a": "1\n" });
    write(dir, "a", "2\n");
    const out = path.join(tempDir(), "pwn");
    const r = await loadChanges({ paths: [`--output=${out}`] }, { cwd: dir, git: runGit, readFile: readConfinedText, limits: LIMITS });
    expect(existsSync(out)).toBe(false);
    expect(r.ok && r.files).toEqual([]);
  });
});
