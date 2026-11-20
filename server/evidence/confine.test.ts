import { mkdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readConfinedText, sha256 } from "./confine";
import { tempDir, write } from "./test-support";

vi.mock("node:fs/promises", { spy: true });

function setup() {
  const base = tempDir();
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  mkdirSync(ws);
  mkdirSync(outside);
  write(outside, "secret.txt", "secret\n");
  write(ws, "a.txt", "one\ntwo\n");
  return { base, ws, outside };
}
const read = (ws: string, p: string, extra: Partial<Parameters<typeof readConfinedText>[1]> = {}) =>
  readConfinedText(p, { cwd: ws, roots: [ws], maxBytes: 1000, ...extra });

describe("readConfinedText", () => {
  it("reads a file, with its hash and size", async () => {
    const { ws } = setup();
    const r = await read(ws, "a.txt");
    expect(r).toMatchObject({ ok: true, text: "one\ntwo\n", bytes: 8, hash: sha256("one\ntwo\n") });
  });
  it("refuses an ordinary file when descriptor verification is unavailable", async () => {
    const { ws } = setup();
    const readlink = vi.spyOn(fs, "readlink").mockRejectedValueOnce(new Error("descriptor path unavailable"));
    try {
      expect(await read(ws, "a.txt")).toMatchObject({
        ok: false, reason: "unverifiable", message: "cannot verify the opened file through /proc/self/fd",
      });
    } finally {
      readlink.mockRestore();
    }
  });
  it("reports the Linux requirement before opening a file on other platforms", async () => {
    const { ws } = setup();
    const open = vi.spyOn(fs, "open").mockClear();
    vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
    try {
      expect(await read(ws, "a.txt")).toMatchObject({
        ok: false, reason: "unverifiable", message: expect.stringContaining("requires Linux"),
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      open.mockRestore();
    }
  });
  it("reads paths with spaces and unicode", async () => {
    const { ws } = setup();
    write(ws, "dir with space/héllo ü.txt", "x\n");
    expect(await read(ws, "dir with space/héllo ü.txt")).toMatchObject({ ok: true, text: "x\n" });
  });
  it("reads an absolute path inside the workspace, refuses one outside", async () => {
    const { ws, outside } = setup();
    expect(await read(ws, path.join(ws, "a.txt"))).toMatchObject({ ok: true });
    expect(await read(ws, path.join(outside, "secret.txt"))).toMatchObject({ ok: false, reason: "outside" });
    expect(await read(ws, "/etc/hostname")).toMatchObject({ ok: false, reason: "outside" });
  });
  it("reads from an extra root", async () => {
    const { ws, outside } = setup();
    const r = await readConfinedText(path.join(outside, "secret.txt"), { cwd: ws, roots: [ws, outside], maxBytes: 1000 });
    expect(r).toMatchObject({ ok: true });
  });
  it("refuses `..` segments, even ones that stay inside", async () => {
    const { ws } = setup();
    expect(await read(ws, "../outside/secret.txt")).toMatchObject({ ok: false, reason: "syntax" });
    expect(await read(ws, "sub/../a.txt")).toMatchObject({ ok: false, reason: "syntax" });
    expect(await read(ws, "..")).toMatchObject({ ok: false, reason: "syntax" });
  });
  it("refuses empty paths and NUL bytes", async () => {
    const { ws } = setup();
    expect(await read(ws, "")).toMatchObject({ ok: false, reason: "syntax" });
    expect(await read(ws, "a\0.txt")).toMatchObject({ ok: false, reason: "syntax" });
  });
  it("refuses a symlink to a file outside the workspace", async () => {
    const { ws, outside } = setup();
    symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "link.txt"));
    expect(await read(ws, "link.txt")).toMatchObject({ ok: false, reason: "outside" });
  });
  it("refuses a symlinked parent directory that leads out", async () => {
    const { ws, outside } = setup();
    symlinkSync(outside, path.join(ws, "dirlink"));
    expect(await read(ws, "dirlink/secret.txt")).toMatchObject({ ok: false, reason: "outside" });
  });
  it("refuses a chain of links that ends outside", async () => {
    const { ws, outside } = setup();
    symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "hop2"));
    symlinkSync(path.join(ws, "hop2"), path.join(ws, "hop1"));
    expect(await read(ws, "hop1")).toMatchObject({ ok: false, reason: "outside" });
  });
  it("refuses a path that resolves out through a link made after the first read", async () => {
    const { ws, outside } = setup();
    write(ws, "later.txt", "fine\n");
    expect(await read(ws, "later.txt")).toMatchObject({ ok: true });
    unlinkSync(path.join(ws, "later.txt"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "later.txt"));
    expect(await read(ws, "later.txt")).toMatchObject({ ok: false, reason: "outside" });
  });
  it("follows a link that stays inside the workspace", async () => {
    const { ws } = setup();
    symlinkSync(path.join(ws, "a.txt"), path.join(ws, "inner"));
    expect(await read(ws, "inner")).toMatchObject({ ok: true, text: "one\ntwo\n" });
  });
  it("is not fooled by a sibling folder with the workspace's name as a prefix", async () => {
    const { base, ws } = setup();
    const sibling = path.join(base, "ws-evil");
    mkdirSync(sibling);
    write(sibling, "x.txt", "x");
    expect(await read(ws, path.join(sibling, "x.txt"))).toMatchObject({ ok: false, reason: "outside" });
  });
  it("reports missing, directory, binary, too-large", async () => {
    const { ws } = setup();
    mkdirSync(path.join(ws, "d"));
    write(ws, "bin", Buffer.from([65, 0, 66]));
    write(ws, "big", "x".repeat(1001));
    expect(await read(ws, "nope.txt")).toMatchObject({ ok: false, reason: "missing" });
    expect(await read(ws, "d")).toMatchObject({ ok: false, reason: "not-file" });
    expect(await read(ws, "bin")).toMatchObject({ ok: false, reason: "binary" });
    const big = await read(ws, "big");
    expect(big).toMatchObject({ ok: false, reason: "too-large" });
    expect(await read(ws, "big", { maxBytes: 1001 })).toMatchObject({ ok: true });
  });
  it("refuses a FIFO without hanging", async () => {
    const { ws } = setup();
    execFileSync("mkfifo", [path.join(ws, "pipe")]);
    const r = await read(ws, "pipe");
    expect(r).toMatchObject({ ok: false });
  }, 5000);
  it("a missing file under a missing parent is missing, not outside", async () => {
    const { ws } = setup();
    expect(await read(ws, "no/such/dir/x.txt")).toMatchObject({ ok: false, reason: "missing" });
  });
  it("a dangling link is refused", async () => {
    const { ws } = setup();
    symlinkSync(path.join(ws, "gone"), path.join(ws, "dangling"));
    expect(await read(ws, "dangling")).toMatchObject({ ok: false });
  });

  describe("a parent directory swapped for a link while the file is being read", () => {
    function racy() {
      const { ws, outside } = setup();
      write(ws, "sub/f.txt", "inside\n");
      write(outside, "f.txt", "OUTSIDE SECRET\n");
      const away = path.join(ws, "..", "sub-moved");
      const swap = () => {
        renameSync(path.join(ws, "sub"), away);
        symlinkSync(outside, path.join(ws, "sub"));
      };
      const swapBack = () => {
        unlinkSync(path.join(ws, "sub"));
        renameSync(away, path.join(ws, "sub"));
      };
      return { ws, swap, swapBack };
    }
    it("swapped after the check, before the open: refused, nothing outside is returned", async () => {
      const { ws, swap } = racy();
      const r = await read(ws, "sub/f.txt", { hooks: { beforeOpen: swap } });
      expect(r).toMatchObject({ ok: false, reason: "outside" });
      expect(JSON.stringify(r)).not.toContain("SECRET");
    });
    it("swapped before the open and swapped back right after it: still refused", async () => {
      const { ws, swap, swapBack } = racy();
      const r = await read(ws, "sub/f.txt", { hooks: { beforeOpen: swap, afterOpen: swapBack } });
      expect(r).toMatchObject({ ok: false, reason: "outside" });
      expect(JSON.stringify(r)).not.toContain("SECRET");
    });
    it("swapped to a link inside the workspace: the file read is the one opened, and it is allowed", async () => {
      const { ws } = setup();
      write(ws, "sub/f.txt", "one\n");
      write(ws, "other/f.txt", "two\n");
      const r = await read(ws, "sub/f.txt", {
        hooks: {
          beforeOpen: () => {
            renameSync(path.join(ws, "sub"), path.join(ws, "sub-moved"));
            symlinkSync(path.join(ws, "other"), path.join(ws, "sub"));
          },
        },
      });
      expect(r).toMatchObject({ ok: true, text: "two\n" });
    });
    it("with no swap, the hooks change nothing", async () => {
      const { ws } = setup();
      write(ws, "sub/f.txt", "same\n");
      expect(await read(ws, "sub/f.txt", { hooks: { beforeOpen: () => {}, afterOpen: () => {} } })).toMatchObject({ ok: true, text: "same\n" });
    });
  });
});
