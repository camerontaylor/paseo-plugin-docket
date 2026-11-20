import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../shared/limits";
import { loadChanges } from "./changes";
import { readConfinedText } from "./confine";
import { runGit } from "./git";
import { readEvidence, removeEvidence, snapshotStatus, writeEvidence } from "./store";
import { loadEvidence } from "./load";
import { makeRepo, tempDir, write } from "./test-support";

const SID = "s_8f2k3a";

describe("snapshot files", () => {
  it("writes each snapshot 0600 in 0700 directories, and reads it back", async () => {
    const data = tempDir();
    await writeEvidence(data, SID, { "1": "one", "2": "tö\n" });
    expect(await readEvidence(data, SID, "1")).toBe("one");
    expect(await readEvidence(data, SID, "2")).toBe("tö\n");
    const dir = path.join(data, "evidence", SID);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "1")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(["1", "2"]);
  });
  it("leaves no temporary files, and a rewrite replaces", async () => {
    const data = tempDir();
    await writeEvidence(data, SID, { "1": "a" });
    await writeEvidence(data, SID, { "1": "b" });
    expect(await readEvidence(data, SID, "1")).toBe("b");
    expect(readdirSync(path.join(data, "evidence", SID))).toEqual(["1"]);
  });
  it("a missing snapshot reads as null; removal clears the surface", async () => {
    const data = tempDir();
    expect(await readEvidence(data, SID, "1")).toBeNull();
    await writeEvidence(data, SID, { "1": "a" });
    await removeEvidence(data, SID);
    expect(await readEvidence(data, SID, "1")).toBeNull();
    await removeEvidence(data, "s_zzzzzz");
  });
  it("refuses ids that could escape the evidence folder", async () => {
    const data = tempDir();
    for (const bad of ["", "..", "../x", "a/b", "a\0b", ".", "/abs", "s_8f2k3", "S_8F2K3A"]) {
      await expect(writeEvidence(data, bad, { "1": "x" }), bad).rejects.toThrow();
      await expect(readEvidence(data, bad, "1"), bad).rejects.toThrow();
    }
    for (const bad of ["", "..", "../1", "1/2", "a b"]) {
      await expect(writeEvidence(data, SID, { [bad]: "x" }), bad).rejects.toThrow();
      await expect(readEvidence(data, SID, bad), bad).rejects.toThrow();
    }
    expect(() => writeFileSync(path.join(data, "ok"), "")).not.toThrow();
  });
});

describe("changed since", () => {
  const opts = (cwd: string) => ({ cwd });

  it("a file excerpt still reads as shown after the file is edited, and is marked changed", async () => {
    const dir = makeRepo({ "src/a.ts": "one\ntwo\nthree\n" });
    const doc = { v: 1 as const, summary: "s", view: { t: "code" as const, id: "c", file: "src/a.ts", from: 1, to: 2 } };
    const loaded = await loadEvidence(doc, { cwd: dir });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const data = tempDir();
    await writeEvidence(data, SID, loaded.evidence.contents);
    const meta = loaded.evidence.snapshots["1"];

    expect(await snapshotStatus(meta, opts(dir))).toEqual({ status: "same" });

    write(dir, "src/a.ts", "ONE\ntwo\nthree\nfour\n");
    expect(await readEvidence(data, SID, "1")).toBe("one\ntwo"); // as shown
    expect((await snapshotStatus(meta, opts(dir))).status).toBe("changed");

    // an edit outside the excerpt changes the file too
    write(dir, "src/a.ts", "one\ntwo\nthree\nfour\n");
    expect((await snapshotStatus(meta, opts(dir))).status).toBe("changed");

    write(dir, "src/a.ts", "one\ntwo\nthree\n");
    expect((await snapshotStatus(meta, opts(dir))).status).toBe("same");
  });
  it("a deleted file is gone, with a reason", async () => {
    const dir = makeRepo({ "a.ts": "x\n" });
    const loaded = await loadEvidence({ v: 1, summary: "s", view: { t: "code", file: "a.ts" } }, { cwd: dir });
    if (!loaded.ok) throw new Error("load");
    const { rmSync } = await import("node:fs");
    rmSync(path.join(dir, "a.ts"));
    const s = await snapshotStatus(loaded.evidence.snapshots["1"], opts(dir));
    expect(s.status).toBe("gone");
    expect(s.detail).toBeTruthy();
  });
  it("a file replaced by a link that leads out is gone, not readable", async () => {
    const dir = makeRepo({ "a.ts": "x\n" });
    const loaded = await loadEvidence({ v: 1, summary: "s", view: { t: "code", file: "a.ts" } }, { cwd: dir });
    if (!loaded.ok) throw new Error("load");
    const out = tempDir();
    write(out, "s", "x\n");
    const { rmSync, symlinkSync } = await import("node:fs");
    rmSync(path.join(dir, "a.ts"));
    symlinkSync(path.join(out, "s"), path.join(dir, "a.ts"));
    expect((await snapshotStatus(loaded.evidence.snapshots["1"], opts(dir))).status).toBe("gone");
  });
  it("changes: same until the diff differs; gone when git cannot answer", async () => {
    const dir = makeRepo({ "a": "1\n" });
    write(dir, "a", "2\n");
    const r = await loadChanges({}, { cwd: dir, git: runGit, readFile: readConfinedText, limits: LIMITS });
    if (!r.ok) throw new Error("changes");
    const meta = { kind: "changes" as const, of: "worktree", hash: r.hash, readAt: "x", bytes: 1 };
    expect((await snapshotStatus(meta, opts(dir))).status).toBe("same");
    write(dir, "a", "3\n");
    expect((await snapshotStatus(meta, opts(dir))).status).toBe("changed");
    write(dir, "a", "2\n");
    expect((await snapshotStatus(meta, opts(dir))).status).toBe("same");
    expect((await snapshotStatus(meta, opts(tempDir()))).status).toBe("gone");
  });
  it("a snapshot that does not name its file is gone", async () => {
    const dir = makeRepo();
    expect((await snapshotStatus({ kind: "file", hash: "sha256:x", readAt: "x", bytes: 1 }, opts(dir))).status).toBe("gone");
  });
});
