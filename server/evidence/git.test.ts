import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
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
      await expect(runGit(dir, [sub], { maxBytes: 100 }), sub).rejects.toThrow(/read-only/);
    }
    await expect(runGit(dir, [], { maxBytes: 100 })).rejects.toThrow();
    // `config` is only ever run by the runner itself, in one fixed form
    await expect(runGit(dir, ["config", "--list"], { maxBytes: 100 })).rejects.toThrow();
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

describe("filters defined in the repository's own config", () => {
  function hostile() {
    const dir = makeRepo({ "a.txt": "1\n", "b.dat": "1\n", "c.md": "1\n" });
    const marks = tempDir("docket-marks-");
    const script = (name: string) => {
      const p = write(marks, name + ".sh", `#!/bin/sh\ntouch "${marks}/${name}.ran"\ncat\n`);
      chmodSync(p, 0o755);
      return p;
    };
    git(dir, "config", "filter.x.clean", script("clean"));
    git(dir, "config", "filter.x.smudge", script("smudge"));
    git(dir, "config", "filter.x.required", "true");
    git(dir, "config", "filter.p.process", script("process"));
    git(dir, "config", "filter.Dotted.Name.clean", script("dotted"));
    // the attributes live where a clone cannot ship them but a local config can
    write(dir, ".git/info/attributes", "*.txt filter=x\n*.dat filter=p\n*.md filter=Dotted.Name\n");
    return { dir, marks };
  }
  const ran = (marks: string, n: string) => existsSync(path.join(marks, `${n}.ran`));

  it("runs no clean, smudge, process or required filter from .git/config and .git/info/attributes", async () => {
    const { dir, marks } = hostile();
    write(dir, "a.txt", "2\n");
    write(dir, "b.dat", "2\n");
    write(dir, "c.md", "2\n");
    write(dir, "new.txt", "n\n");
    const r = await loadChanges({}, { cwd: dir, git: runGit, readFile: readConfinedText, limits: LIMITS });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files.map((f) => f.path)).toEqual(["a.txt", "b.dat", "c.md", "new.txt"]);
    for (const n of ["clean", "smudge", "process", "dotted"]) expect(ran(marks, n), n).toBe(false);
  });
  it("also for a commit and a range, and for ls-files", async () => {
    const { dir, marks } = hostile();
    write(dir, "a.txt", "2\n");
    git(dir, "-c", "filter.x.clean=cat", "-c", "filter.p.process=", "-c", "filter.Dotted.Name.clean=cat", "add", "-A");
    git(dir, "commit", "-q", "-m", "two");
    for (const n of ["clean", "smudge", "process", "dotted"]) rmSync(path.join(marks, `${n}.ran`), { force: true });
    for (const of of ["HEAD", "HEAD~1..HEAD", "HEAD~1...HEAD"]) {
      expect((await loadChanges({ of }, { cwd: dir, git: runGit, readFile: readConfinedText, limits: LIMITS })).ok, of).toBe(true);
    }
    for (const n of ["clean", "smudge", "process", "dotted"]) expect(ran(marks, n), n).toBe(false);
  });
  it("a filter defined through an included config file is neutralised too", async () => {
    const dir = makeRepo({ "a.txt": "1\n" });
    const marks = tempDir("docket-marks-");
    const p = write(marks, "inc.sh", `#!/bin/sh\ntouch "${marks}/inc.ran"\ncat\n`);
    chmodSync(p, 0o755);
    write(dir, ".git/extra.cfg", `[filter "inc"]\n\tclean = ${p}\n`);
    git(dir, "config", "include.path", path.join(dir, ".git/extra.cfg"));
    write(dir, ".git/info/attributes", "*.txt filter=inc\n");
    write(dir, "a.txt", "2\n");
    expect((await loadChanges({}, { cwd: dir, git: runGit, readFile: readConfinedText, limits: LIMITS })).ok).toBe(true);
    expect(ran(marks, "inc")).toBe(false);
  });
  it("fails closed when git is stopped before the diff", async () => {
    const dir = makeRepo();
    const r = await runGit(dir, ["diff", "--name-status"], { maxBytes: 100, signal: AbortSignal.abort() });
    expect(r.ok).toBe(false);
  });
  it("a filter written to the config at any moment during loading never runs", async () => {
    const dir = makeRepo({ "a.txt": "1\n" });
    const marks = tempDir("docket-marks-");
    const p = write(marks, "late.sh", `#!/bin/sh\ntouch "${marks}/late.ran"\ncat\n`);
    chmodSync(p, 0o755);
    write(dir, "a.txt", "2\n");
    // the writer strikes right before every git call, including the one that runs the diff
    const racing: typeof runGit = async (cwd, args, options) => {
      git(dir, "config", "filter.late.clean", p);
      write(dir, ".git/info/attributes", "*.txt filter=late\n");
      return runGit(cwd, args, options);
    };
    const r = await loadChanges({}, { cwd: dir, git: racing, readFile: readConfinedText, limits: LIMITS });
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(ran(marks, "late")).toBe(false);
  });
  it("works from a subdirectory and leaves the real index and temp area clean", async () => {
    const dir = makeRepo({ "sub/a.txt": "1\n" });
    write(dir, "sub/a.txt", "2\n");
    const before = readFileSync(path.join(dir, ".git/index"));
    const r = await runGit(path.join(dir, "sub"), ["diff", "--name-only", "--relative"], { maxBytes: 1000 });
    expect(r).toMatchObject({ ok: true, stdout: "a.txt\n" });
    expect(readFileSync(path.join(dir, ".git/index")).equals(before)).toBe(true);
  });
  it("diffs a repository with no commit yet", async () => {
    const dir = tempDir("docket-unborn-");
    git(dir, "init", "-q");
    write(dir, "a.txt", "1\n");
    git(dir, "add", "a.txt");
    const r = await runGit(dir, ["diff", "--cached", "--name-only"], { maxBytes: 1000 });
    expect(r.ok).toBe(true);
  });
});
