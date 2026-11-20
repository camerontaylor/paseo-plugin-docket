import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SurfaceDocument, LIMITS } from "../shared";
import { type CrashPoint, type Store, InjectedCrash, defaultStoreRoot, openStore } from "./store";

const DOC: SurfaceDocument = {
  v: 1,
  summary: "Mailer rollout",
  questions: [
    { id: "queue", kind: "choice", prompt: "Which queue?", label: "Queue", options: ["pg_boss", { id: "bullmq", label: "BullMQ" }] },
    { id: "name", kind: "text", prompt: "Name it?" },
    { id: "chk", kind: "review", prompt: "Check", items: [{ id: "a", title: "Add the table" }, { id: "b", title: "Drop cron" }] },
  ],
};

let dir: string;
let clock: number;
let seq: number;
const open = (extra: Parameters<typeof openStore>[0] = {}): Promise<Store> =>
  openStore({ root: dir, now: () => new Date(clock), random: () => ((seq = (seq * 7919 + 13) % 997) / 997), ...extra });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "docket-store-"));
  clock = Date.parse("2026-11-21T10:00:00.000Z");
  seq = 1;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const must = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const crashAt = (point: CrashPoint) => (p: CrashPoint) => {
  if (p === point) throw new InjectedCrash(p);
};
const mode = async (p: string): Promise<number> => (await fs.stat(p)).mode & 0o777;

async function answered(store: Store, id: string, targets: string[] = ["queue"], deliver = true): Promise<void> {
  for (const t of targets) {
    const content = t === "queue" ? { value: "bullmq", note: "cheaper to run" } : t === "name" ? { value: "mailer" } : { verdict: "change", comment: "keep cron" };
    must(await store.apply(id, { kind: "setDraft", target: t, draft: content, baseVersion: 0, now: new Date(clock).toISOString() }));
  }
  must(await store.apply(id, { kind: "send", targets: targets.map((target) => ({ target, version: 1 })), skip: ["name", "chk"].filter((x) => !targets.some((t) => t === x || t.startsWith(x + "."))), now: new Date(clock).toISOString() }));
  if (deliver) for (const d of store.get(id)!.deliveries) must(await store.apply(id, { kind: "updateDelivery", n: d.n, to: "delivered", now: new Date(clock).toISOString() }));
}

describe("store root", () => {
  it("is plugin-data/docket under PASEO_HOME, or ~/.paseo", () => {
    expect(defaultStoreRoot({ PASEO_HOME: "/x/paseo" })).toBe("/x/paseo/plugin-data/docket");
    expect(defaultStoreRoot({ PASEO_HOME: "" })).toMatch(/\.paseo\/plugin-data\/docket$/);
    expect(defaultStoreRoot({})).toMatch(/\.paseo\/plugin-data\/docket$/);
  });
});

describe("create and files", () => {
  it("writes a record with modes 0600 files and 0700 directories, and no temp file left", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC, evidence: { "changes.json": "{}" } }));
    expect(record.rev).toBe(1);
    const file = path.join(dir, "surfaces", record.id, "record.json");
    expect(await mode(file)).toBe(0o600);
    expect(await mode(path.join(dir, "surfaces", record.id))).toBe(0o700);
    expect(await mode(path.join(dir, "surfaces"))).toBe(0o700);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(path.join(dir, "evidence", record.id, "changes.json"))).toBe(0o600);
    expect((await fs.readdir(path.join(dir, "surfaces", record.id))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(await fs.readFile(file, "utf8")).id).toBe(record.id);
    expect(store.get(record.id)).toBe(record);
  });

  it("raises rev on every write, reads back after a reopen, and skips the write for a no-op", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    const set = must(await store.apply(record.id, { kind: "setDraft", target: "name", draft: { value: "x" }, baseVersion: 0, now: "2026-11-21T10:00:01.000Z" }));
    expect(set.record.rev).toBe(2);
    const noop = must(await store.apply(record.id, { kind: "agentRestored", now: "2026-11-21T10:00:02.000Z" }));
    expect(noop.record.rev).toBe(2);
    const again = await open();
    expect(again.get(record.id)).toEqual(set.record);
  });

  it("refuses and writes nothing for an invalid command, and for an unknown surface", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    const r = await store.apply(record.id, { kind: "setDraft", target: "queue", draft: { value: "nope" }, baseVersion: 0, now: "x" });
    expect(r.ok).toBe(false);
    expect(store.get(record.id)?.rev).toBe(1);
    const missing = await store.apply("s_nope", { kind: "close", now: "x" });
    expect(!missing.ok && missing.refusal.code).toBe("unknown-target");
  });

  it("notifies listeners with the new rev", async () => {
    const store = await open();
    const seen: string[] = [];
    const off = store.onChange((e) => seen.push(`${e.surfaceId}@${e.rev}${e.removed ? "!" : ""}`));
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    must(await store.apply(record.id, { kind: "close", now: "2026-11-21T10:00:01.000Z" }));
    off();
    must(await store.apply(record.id, { kind: "holdOnArchive", now: "2026-11-21T10:00:02.000Z" }));
    expect(seen).toEqual([`${record.id}@1`, `${record.id}@2`]);
  });
});

describe("one write at a time", () => {
  it("serialises concurrent writes to one surface: two writers with the same base, one wins", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    const cmd = (value: string) => ({ kind: "setDraft" as const, target: "name", draft: { value }, baseVersion: 0, now: "2026-11-21T10:00:01.000Z" });
    const [a, b] = await Promise.all([store.apply(record.id, cmd("one")), store.apply(record.id, cmd("two"))]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const lost = (a.ok ? b : a) as { ok: false; refusal: { code: string } };
    expect(lost.refusal.code).toBe("stale-draft");
    expect(store.get(record.id)?.rev).toBe(2);
  });

  it("serialises creates so the twenty-open limit holds under a burst", async () => {
    const store = await open();
    const results = await Promise.all(Array.from({ length: LIMITS.openSurfacesPerAgent + 3 }, () => store.create({ agentId: "ag1", document: DOC })));
    expect(results.filter((r) => r.ok)).toHaveLength(LIMITS.openSurfacesPerAgent);
    const refused = results.filter((r) => !r.ok) as { ok: false; refusal: { code: string; open?: string[] } }[];
    expect(refused).toHaveLength(3);
    expect(refused[0].refusal.code).toBe("too-many-open");
    expect(refused[0].refusal.open).toHaveLength(LIMITS.openSurfacesPerAgent);
    expect(new Set(store.list().map((r) => r.id)).size).toBe(LIMITS.openSurfacesPerAgent);
  });

  it("counts open surfaces per agent, and a resolved or closed one frees a slot", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < LIMITS.openSurfacesPerAgent; i++) ids.push(must(await store.create({ agentId: "ag1", document: DOC })).record.id);
    expect((await store.create({ agentId: "ag1", document: DOC })).ok).toBe(false);
    expect((await store.create({ agentId: "ag2", document: DOC })).ok).toBe(true);
    must(await store.apply(ids[0], { kind: "close", now: "2026-11-21T10:00:01.000Z" }));
    expect((await store.create({ agentId: "ag1", document: DOC })).ok).toBe(true);
  });
});

describe("replacement", () => {
  it("starts the new surface open and closes the old one", async () => {
    const store = await open();
    const old = must(await store.create({ agentId: "ag1", document: DOC })).record;
    const next = must(await store.create({ agentId: "ag1", document: { ...DOC, revises: old.id } })).record;
    expect(next.revises).toBe(old.id);
    expect(store.get(next.id)?.questions.queue.state).toBe("open");
    const closed = store.get(old.id)!;
    expect(closed.replacedBy).toBe(next.id);
    expect(closed.closed?.by).toBe("replaced");
    expect(closed.questions.queue.state).toBe("closed");
  });

  it("is allowed at the open-surface limit, since the old one closes", async () => {
    const store = await open();
    const ids: string[] = [];
    for (let i = 0; i < LIMITS.openSurfacesPerAgent; i++) ids.push(must(await store.create({ agentId: "ag1", document: DOC })).record.id);
    expect((await store.create({ agentId: "ag1", document: { ...DOC, revises: ids[0] } })).ok).toBe(true);
  });

  it("refuses a revision of an unknown or foreign surface and writes nothing", async () => {
    const store = await open();
    const other = must(await store.create({ agentId: "ag2", document: DOC })).record;
    const before = store.list().length;
    const foreign = await store.create({ agentId: "ag1", document: { ...DOC, revises: other.id } });
    expect(!foreign.ok && foreign.refusal.code).toBe("revises-foreign");
    const missing = await store.create({ agentId: "ag1", document: { ...DOC, revises: "s_nope" } });
    expect(!missing.ok && missing.refusal.code).toBe("revises-missing");
    expect(store.list()).toHaveLength(before);
    expect(store.get(other.id)?.closed).toBeNull();
  });

  it("leaves a store that starts cleanly when the process dies between its two writes, and repairs the old surface", async () => {
    const first = await open();
    const old = must(await first.create({ agentId: "ag1", document: DOC })).record;
    const dying = await open({ crashAt: crashAt("replace:new-written") });
    await expect(dying.create({ agentId: "ag1", document: { ...DOC, revises: old.id } })).rejects.toBeInstanceOf(InjectedCrash);
    // On disk: the new record is written, the old one is still open.
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, "surfaces", old.id, "record.json"), "utf8"));
    expect(onDisk.closed).toBeNull();
    const restarted = await open();
    expect(restarted.unreadable).toEqual([]);
    const repaired = restarted.get(old.id)!;
    expect(repaired.closed?.by).toBe("replaced");
    const revisers = restarted.list().filter((r) => r.revises === old.id);
    expect(revisers).toHaveLength(1);
    expect(repaired.replacedBy).toBe(revisers[0].id);
    expect(revisers[0].questions.queue.state).toBe("open");
    // The repair is itself durable.
    const third = await open();
    expect(third.get(old.id)?.replacedBy).toBe(revisers[0].id);
    expect(third.get(old.id)?.rev).toBe(repaired.rev);
  });

  it("gives the first reviser the link when two revisions were left behind", async () => {
    const first = await open();
    const old = must(await first.create({ agentId: "ag1", document: DOC })).record;
    clock += 1000;
    const one = await open({ crashAt: crashAt("replace:new-written") });
    await expect(one.create({ agentId: "ag1", document: { ...DOC, revises: old.id } })).rejects.toBeInstanceOf(InjectedCrash);
    clock += 1000;
    const two = await open({ crashAt: crashAt("replace:new-written") });
    await expect(two.create({ agentId: "ag1", document: { ...DOC, revises: old.id } })).rejects.toBeInstanceOf(InjectedCrash);
    const restarted = await open();
    const revisers = restarted.list().filter((r) => r.revises === old.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    expect(revisers).toHaveLength(2);
    expect(restarted.get(old.id)?.replacedBy).toBe(revisers[0].id);
  });
});

describe("crashes between writes", () => {
  it("between the evidence write and the record write: starts cleanly and sweeps the orphaned evidence", async () => {
    const dying = await open({ crashAt: crashAt("create:evidence-written") });
    await expect(dying.create({ agentId: "ag1", document: DOC, evidence: { "a.txt": "evidence" } })).rejects.toBeInstanceOf(InjectedCrash);
    expect((await fs.readdir(path.join(dir, "evidence"))).length).toBe(1);
    expect(await fs.readdir(path.join(dir, "surfaces"))).toEqual([]);
    const restarted = await open();
    expect(restarted.list()).toEqual([]);
    expect(restarted.unreadable).toEqual([]);
    expect(await fs.readdir(path.join(dir, "evidence"))).toEqual([]);
    // and the store is usable, including the id the dead create had picked
    expect((await restarted.create({ agentId: "ag1", document: DOC })).ok).toBe(true);
  });

  it("a crash after the temp file and before the rename leaves the old record and no temp file after start", async () => {
    const first = await open();
    const { record } = must(await first.create({ agentId: "ag1", document: DOC }));
    const dying = await open({ crashAt: crashAt("write:tmp-written") });
    await expect(dying.apply(record.id, { kind: "close", now: "2026-11-21T10:00:01.000Z" })).rejects.toBeInstanceOf(InjectedCrash);
    expect((await fs.readdir(path.join(dir, "surfaces", record.id))).some((n) => n.endsWith(".tmp"))).toBe(true);
    const restarted = await open();
    expect((await fs.readdir(path.join(dir, "surfaces", record.id))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    expect(restarted.get(record.id)?.rev).toBe(1);
    expect(restarted.get(record.id)?.closed).toBeNull();
  });

  it("a failed write leaves the in-memory record at the last durable version", async () => {
    const store = await open({ crashAt: (p) => { if (p === "write:tmp-written" && fail) throw new InjectedCrash(p); } });
    var fail = false;
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    fail = true;
    await expect(store.apply(record.id, { kind: "close", now: "2026-11-21T10:00:01.000Z" })).rejects.toBeInstanceOf(InjectedCrash);
    expect(store.get(record.id)?.rev).toBe(1);
    fail = false;
    expect(must(await store.apply(record.id, { kind: "close", now: "2026-11-21T10:00:02.000Z" })).record.rev).toBe(2);
  });
});

describe("start scan", () => {
  it("leaves a record with an unknown schema untouched, lists it, and loads the rest", async () => {
    const first = await open();
    const good = must(await first.create({ agentId: "ag1", document: DOC })).record;
    const future = path.join(dir, "surfaces", "s_future");
    await fs.mkdir(future, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ schema: 2, id: "s_future", rev: 9, something: "new" });
    await fs.writeFile(path.join(future, "record.json"), body, { mode: 0o600 });
    const broken = path.join(dir, "surfaces", "s_broken");
    await fs.mkdir(broken, { recursive: true });
    await fs.writeFile(path.join(broken, "record.json"), "{not json");
    const store = await open();
    expect(store.get(good.id)).toBeDefined();
    expect(store.get("s_future")).toBeUndefined();
    expect(store.unreadable.map((u) => [u.surfaceId, u.reason]).sort()).toEqual([
      ["s_broken", "not valid JSON"],
      ["s_future", "unknown schema 2"],
    ]);
    expect(await fs.readFile(path.join(future, "record.json"), "utf8")).toBe(body);
    expect(await fs.readFile(path.join(broken, "record.json"), "utf8")).toBe("{not json");
    expect(store.list().map((r) => r.id)).toEqual([good.id]);
  });

  it("does not pick an id that belongs to an unreadable record, and keeps its evidence", async () => {
    await open();
    const future = path.join(dir, "surfaces", "s_future");
    await fs.mkdir(future, { recursive: true });
    await fs.writeFile(path.join(future, "record.json"), JSON.stringify({ schema: 2, id: "s_future" }));
    await fs.mkdir(path.join(dir, "evidence", "s_future"), { recursive: true });
    await fs.writeFile(path.join(dir, "evidence", "s_future", "x"), "keep");
    await open();
    expect(await fs.readFile(path.join(dir, "evidence", "s_future", "x"), "utf8")).toBe("keep");
  });

  it("ignores a directory with no record (a create that died before its rename)", async () => {
    await open();
    await fs.mkdir(path.join(dir, "surfaces", "s_empty"), { recursive: true });
    const store = await open();
    expect(store.list()).toEqual([]);
    expect(store.unreadable).toEqual([]);
  });

  it("tightens modes on an existing store", async () => {
    await fs.mkdir(path.join(dir, "surfaces"), { recursive: true, mode: 0o755 });
    await fs.chmod(path.join(dir, "surfaces"), 0o755);
    await open();
    expect(await mode(path.join(dir, "surfaces"))).toBe(0o700);
  });
});

describe("delivery states through the store", () => {
  it("persists delivery changes and Retry", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    await answered(store, record.id, ["queue"], false);
    must(await store.apply(record.id, { kind: "updateDelivery", n: 1, to: "failed", patch: { lastError: "boom" }, now: "2026-11-21T10:01:00.000Z" }));
    must(await store.apply(record.id, { kind: "retryDelivery", n: 1, now: "2026-11-21T10:02:00.000Z" }));
    const again = await open();
    expect(again.get(record.id)?.deliveries[0]).toMatchObject({ state: "queued", attempts: 0 });
    expect(again.get(record.id)?.deliveries[0].lastError).toBeUndefined();
  });
});

describe("summaries", () => {
  it("lists open surfaces and those resolved in the last seven days", async () => {
    const store = await open();
    const a = must(await store.create({ agentId: "ag1", workspaceId: "w1", document: DOC })).record;
    const b = must(await store.create({ agentId: "ag2", workspaceId: "w2", document: DOC })).record;
    must(await store.apply(b.id, { kind: "close", now: new Date(clock).toISOString() }));
    expect(store.summaries().map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(store.summaries({ agentId: "ag1" }).map((s) => s.id)).toEqual([a.id]);
    expect(store.summaries({ workspaceId: "w2" }).map((s) => s.id)).toEqual([b.id]);
    clock += 8 * 86_400_000;
    expect(store.summaries().map((s) => s.id)).toEqual([a.id]);
  });
});

describe("decisions, search, deletion and compaction", () => {
  it("finds a decision by words in its note after compaction, with each review item's title", async () => {
    const store = await open({ retentionDays: 30 });
    const { record } = must(await store.create({ agentId: "ag1", document: DOC, evidence: { "x.txt": "e" } }));
    await answered(store, record.id, ["queue", "chk.a", "chk.b"]);
    expect(store.get(record.id)?.questions.name.state).toBe("skipped");
    clock += 31 * 86_400_000;
    expect(await store.compactDue()).toEqual([record.id]);
    const compacted = store.get(record.id)!;
    expect(compacted.document).toBeNull();
    expect(compacted.compactedAt).not.toBeNull();
    await expect(fs.stat(path.join(dir, "evidence", record.id))).rejects.toThrow();
    // across a restart too
    const reopened = await open();
    const found = reopened.decisions({ text: "cheaper" });
    expect(found.map((d) => d.questionId)).toEqual(["queue"]);
    const review = reopened.decisions({ text: "keep cron" });
    expect(review).toHaveLength(1);
    expect(review[0].items?.map((i) => i.title)).toEqual(["Add the table", "Drop cron"]);
    expect(reopened.decisions({ text: "add table" }).map((d) => d.questionId)).toEqual(["chk"]);
    expect(reopened.decisions({ text: "redis" })).toEqual([]);
  });

  it("lists every item's title on an answered review", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    for (const t of ["a", "b"]) {
      must(await store.apply(record.id, { kind: "setDraft", target: `chk.${t}`, draft: { verdict: "approve" }, baseVersion: 0, now: "2026-11-21T10:00:01.000Z" }));
    }
    must(await store.apply(record.id, { kind: "send", targets: [{ target: "chk.a", version: 1 }, { target: "chk.b", version: 1 }], skip: ["queue", "name"], now: "2026-11-21T10:00:02.000Z" }));
    const [d] = store.decisions({ text: "table" });
    expect(d.items?.map((i) => i.title)).toEqual(["Add the table", "Drop cron"]);
  });

  it("does not compact before the retention period, or an open surface", async () => {
    const store = await open({ retentionDays: 30 });
    const open1 = must(await store.create({ agentId: "ag1", document: DOC })).record;
    const done = must(await store.create({ agentId: "ag1", document: DOC })).record;
    await answered(store, done.id);
    clock += 29 * 86_400_000;
    expect(await store.compactDue()).toEqual([]);
    clock += 365 * 86_400_000;
    expect(await store.compactDue()).toEqual([done.id]);
    expect(store.get(open1.id)?.compactedAt).toBeNull();
  });

  it("compacts an orphaned surface and expires its open questions", async () => {
    const store = await open({ retentionDays: 10 });
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    must(await store.apply(record.id, { kind: "holdOnArchive", now: new Date(clock).toISOString() }));
    clock += 11 * 86_400_000;
    expect(await store.compactDue()).toEqual([record.id]);
    expect(store.get(record.id)?.closed?.by).toBe("expired");
  });

  it("a crash after the compacted record was written and before its evidence went leaves a store that sweeps it", async () => {
    const store = await open({ retentionDays: 1 });
    const { record } = must(await store.create({ agentId: "ag1", document: DOC, evidence: { "x.txt": "e" } }));
    await answered(store, record.id);
    clock += 3 * 86_400_000;
    // write the compacted record, then "die" before the evidence directory is removed
    must(await store.apply(record.id, { kind: "compact", now: new Date(clock).toISOString(), retentionDays: 1 }));
    await expect(fs.stat(path.join(dir, "evidence", record.id))).resolves.toBeTruthy();
    await open();
    await expect(fs.stat(path.join(dir, "evidence", record.id))).rejects.toThrow();
  });

  it("deletes one decision, then removes the whole record and its evidence once none is left", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC, evidence: { "x.txt": "e" } }));
    await answered(store, record.id, ["queue", "chk.a", "chk.b"]);
    const events: string[] = [];
    store.onChange((e) => events.push(e.removed ? "removed" : "changed"));
    must(await store.deleteDecision(record.id, "queue"));
    expect(store.decisions().map((d) => d.questionId)).toEqual(["chk"]);
    expect(store.get(record.id)).toBeDefined();
    must(await store.deleteDecision(record.id, "chk"));
    expect(store.get(record.id)).toBeUndefined();
    expect(events).toEqual(["changed", "removed"]);
    await expect(fs.stat(path.join(dir, "surfaces", record.id))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, "evidence", record.id))).rejects.toThrow();
    expect((await open()).list()).toEqual([]);
  });

  it("keeps an open surface after its answered decision is deleted", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    await answered(store, record.id, ["name"]);
    must(await store.apply(record.id, { kind: "setDraft", target: "queue", draft: { value: "bullmq" }, baseVersion: 0, now: new Date(clock).toISOString() }));
    must(await store.deleteDecision(record.id, "name"));
    expect(store.get(record.id)).toBeDefined();
  });

  it("deletes every decision of one agent and no one else's", async () => {
    const store = await open();
    const a = must(await store.create({ agentId: "ag1", document: DOC })).record;
    const b = must(await store.create({ agentId: "ag2", document: DOC })).record;
    await answered(store, a.id);
    await answered(store, b.id);
    expect(await store.deleteAgentDecisions("ag1")).toBe(1);
    expect(store.decisions().map((d) => d.agentId)).toEqual(["ag2"]);
    expect(await store.deleteAgentDecisions("ag1")).toBe(0);
    expect(store.get(a.id)).toBeUndefined();
  });

  it("refuses to delete a decision of an unknown surface or question", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    expect((await store.deleteDecision("s_nope", "queue")).ok).toBe(false);
    expect((await store.deleteDecision(record.id, "zzz")).ok).toBe(false);
  });
});

describe("events.jsonl", () => {
  it("appends metadata lines with mode 0600", async () => {
    const store = await open();
    await store.recordEvent("surface.created", { surfaceId: "s_1", agentId: "ag1" });
    await store.recordEvent("delivery.delivered", { surfaceId: "s_1", n: 1 });
    const file = path.join(dir, "events.jsonl");
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(["surface.created", "delivery.delivered"]);
    expect(lines[0]).toMatchObject({ surfaceId: "s_1", agentId: "ag1" });
    expect(typeof lines[0].at).toBe("string");
    expect(await mode(file)).toBe(0o600);
  });

  it("writes nothing when recordEvents is off", async () => {
    const store = await open({ recordEvents: false });
    await store.recordEvent("surface.created", { surfaceId: "s_1" });
    await expect(fs.stat(path.join(dir, "events.jsonl"))).rejects.toThrow();
  });
});

describe("review findings on PR 5", () => {
  it("retains a delivered block comment and evidence after deleting the last decision", async () => {
    const store = await open();
    const at = new Date(clock).toISOString();
    const { record } = must(await store.create({
      agentId: "ag1",
      document: {
        v: 1,
        summary: "Mailer rollout",
        questions: [DOC.questions![0]],
        view: [{ t: "plan", steps: [{ id: "step", title: "Set up the queue" }] }],
      },
      evidence: { "x.txt": "e" },
    }));
    const id = record.id;
    must(await store.apply(id, { kind: "setDraft", target: "queue", draft: { value: "bullmq", note: "delete this note" }, baseVersion: 0, now: at }));
    must(await store.apply(id, { kind: "setComment", on: "plan.step", text: "keep this comment", baseVersion: 0, now: at }));
    must(await store.apply(id, { kind: "send", targets: [{ target: "queue", version: 1 }], comments: [{ on: "plan.step", version: 1 }], now: at }));
    must(await store.apply(id, { kind: "updateDelivery", n: 1, to: "delivered", now: at, receivedText: "delete this note" }));
    const comment = store.get(id)?.comments["plan.step"];

    must(await store.deleteDecision(id, "queue"));

    const reopened = await open();
    expect(reopened.get(id)?.comments["plan.step"]).toEqual(comment);
    expect(reopened.get(id)?.deliveries[0]).toMatchObject({ state: "delivered", text: "" });
    expect(reopened.decisions()).toEqual([]);
    expect(await fs.readFile(path.join(dir, "surfaces", id, "record.json"), "utf8")).not.toContain("delete this note");
    await expect(fs.readFile(path.join(dir, "evidence", id, "x.txt"), "utf8")).resolves.toBe("e");
  });

  it("keeps the record while a delivery is pending after its last decision is deleted, then removes it once delivered", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC, evidence: { "x.txt": "e" } }));
    await answered(store, record.id, ["queue", "chk.a", "chk.b"], false);
    // delivery 1 is queued: the deletion is refused, nothing is lost
    expect((await store.deleteDecision(record.id, "queue")).ok).toBe(false);
    expect(store.get(record.id)?.deliveries[0].state).toBe("queued");
    must(await store.apply(record.id, { kind: "updateDelivery", n: 1, to: "delivered", now: new Date(clock).toISOString() }));
    must(await store.deleteDecision(record.id, "queue"));
    must(await store.deleteDecision(record.id, "chk"));
    expect(store.get(record.id)).toBeUndefined();
  });

  it("keeps a record with a separate pending delivery after every decision is deleted, and removes it when that delivers", async () => {
    const store = await open();
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    const at = () => new Date(clock).toISOString();
    must(await store.apply(record.id, { kind: "setDraft", target: "queue", draft: { value: "bullmq" }, baseVersion: 0, now: at() }));
    must(await store.apply(record.id, { kind: "send", targets: [{ target: "queue", version: 1 }], now: at() }));
    must(await store.apply(record.id, { kind: "updateDelivery", n: 1, to: "delivered", now: at() }));
    must(await store.apply(record.id, { kind: "send", targets: [], skip: ["name", "chk"], now: at() }));
    expect(store.get(record.id)?.deliveries[1].state).toBe("queued");
    must(await store.deleteDecision(record.id, "queue"));
    expect(store.get(record.id)).toBeDefined();
    must(await store.apply(record.id, { kind: "updateDelivery", n: 2, to: "delivered", now: at() }));
    expect(store.get(record.id)).toBeUndefined();
  });

  it("deleting every decision of an agent skips those whose delivery is pending", async () => {
    const store = await open();
    const a = must(await store.create({ agentId: "ag1", document: DOC })).record;
    await answered(store, a.id, ["queue"], false);
    expect(await store.deleteAgentDecisions("ag1")).toBe(0);
    expect(store.get(a.id)).toBeDefined();
  });

  it("writes no answer content to events.jsonl, compacted records, or search after deletion", async () => {
    const store = await open({ retentionDays: 1 });
    const { record } = must(await store.create({ agentId: "ag1", document: DOC }));
    await answered(store, record.id, ["queue", "chk.a", "chk.b"]);
    await store.recordEvent("delivery.delivered", { surfaceId: record.id, n: 1 });
    must(await store.deleteDecision(record.id, "queue"));
    clock += 3 * 86_400_000;
    await store.compactDue();
    expect(store.decisions({ text: "cheaper" })).toEqual([]);
    const files = [path.join(dir, "events.jsonl"), path.join(dir, "surfaces", record.id, "record.json")];
    for (const f of files) expect(await fs.readFile(f, "utf8")).not.toContain("cheaper to run");
  });
});

describe("replacement and deletion race", () => {
  it("a deletion started from the new record's change callback runs after the old surface is closed", async () => {
    const store = await open();
    const old = must(await store.create({ agentId: "ag1", document: DOC })).record;
    await answered(store, old.id, ["queue", "chk.a", "chk.b"]);
    let deleting: Promise<unknown> = Promise.resolve();
    store.onChange((e) => {
      if (e.surfaceId !== old.id && !e.removed) deleting = store.apply(old.id, { kind: "deleteDecisions", now: new Date(clock).toISOString() });
    });
    const next = await store.create({ agentId: "ag1", document: { ...DOC, revises: old.id } });
    expect(next.ok).toBe(true);
    await deleting;
    expect(store.list().some((r) => r.revises === old.id)).toBe(true);
    expect(store.get(old.id)).toBeUndefined();
  });
});
