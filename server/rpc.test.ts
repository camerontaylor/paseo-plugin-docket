import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { expect, it, vi } from "vitest";
import { commentSet, decisionsDelete, decisionsSearch, deliveryRetry, draftSet, evidenceGet, send, surfaceGet, surfaces, surfacesList, type SurfaceEvent } from "../shared/rpc";
import { registerRpc } from "./rpc";
import { openStore } from "./store";

it("projects store revisions and routes validated reads, edits and sends to the store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "docket-rpc-"));
  const controller = new AbortController();
  try {
    let clock = Date.now();
    const store = await openStore({ root, now: () => new Date(clock) });
    const created = await store.create({
      agentId: "agent",
      document: {
        v: 1, summary: "Review", context: "Context",
        questions: [{ id: "answer", kind: "text", prompt: "What?", recommend: "Yes" }],
        view: { t: "plan", id: "plan", steps: [{ id: "step", title: "Step" }] },
      },
      snapshots: { "1": { name: "1", kind: "file", hash: "hash", readAt: new Date().toISOString(), bytes: 8 } },
      evidence: { "1": "evidence", "2": "unreferenced" },
    });
    if (!created.ok) throw Error(created.refusal.message);
    const surfaceId = created.record.id;
    const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
    const server = { handle: (contract, handle) => handlers.set(contract.name, handle) } as PluginServerContext;
    const retry = vi.fn(() => Promise.resolve(created));
    registerRpc(server, async () => store, async () => ({ retry }));
    const paseo = { hosts: { list: async () => ({ self: { serverId: "host-a" } }) } };

    async function call<C extends PluginRpcContract>(contract: C, input: unknown) {
      const invoke = handlers.get(contract.name)!;
      const response = await invoke(contract.input.parse(input), { paseo });
      const reply = contract.output.parse(JSON.parse(JSON.stringify(response))) as { hostId: string; result: unknown };
      expect(reply.hostId).toBe("host-a");
      return reply.result;
    }

    const events: SurfaceEvent[] = [];
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const closed = vi.fn();
    const stream = Promise.resolve(handlers.get(surfaces.name)!({}, {
      paseo, signal: controller.signal,
      push: async (event: unknown) => events.push(surfaces.event.parse(event)),
    })).then(closed);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(closed).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      kind: "snapshot", hostId: "host-a", summaries: [{ id: surfaceId, rev: 1, context: "Context", questions: [{ recommend: "Yes" }] }],
    });
    const listed = await call(surfacesList, {});
    expect(listed).toEqual(store.summaries());
    expect(JSON.stringify(listed)).not.toMatch(/"drafts"|"document"|"snapshots"/);
    expect(await call(evidenceGet, { surfaceId, snapshotId: "1" })).toBe("evidence");
    expect(await call(evidenceGet, { surfaceId, snapshotId: "2" })).toBeNull();
    expect(evidenceGet.input.safeParse({ surfaceId, snapshotId: "../record.json" }).success).toBe(false);

    const draft = { surfaceId, target: "answer", draft: { value: "Yes" }, baseVersion: 0 };
    expect(await call(draftSet, draft)).toEqual({ version: 1 });
    expect(await call(draftSet, draft)).toEqual({ conflict: { value: "Yes", version: 1 } });
    expect(events[1]).toMatchObject({ kind: "change", surfaceId, rev: 2, hostId: "host-a" });
    expect(await call(surfaceGet, { surfaceId })).toMatchObject({ drafts: { answer: { value: "Yes", version: 1 } } });
    expect(await call(commentSet, { surfaceId, on: "plan.step", text: "Comment", baseVersion: 0 })).toEqual({ version: 1 });
    expect(await call(send, { surfaceId, targets: [{ target: "answer", version: 0 }] })).toMatchObject({ conflict: [{ target: "answer" }] });
    const submission = { surfaceId, targets: [{ target: "answer", version: 1 }], comments: [{ on: "plan.step", version: 1 }] };
    expect(await call(send, submission)).toMatchObject({ delivery: { n: 1, state: "queued" } });
    expect(await call(send, submission)).toEqual({ closed: true });
    expect(await call(deliveryRetry, { surfaceId, n: 1 })).toEqual({});
    expect(retry).toHaveBeenCalledWith(surfaceId, 1);
    expect(await call(decisionsSearch, { query: "Yes", agentId: "agent", limit: 1 })).toMatchObject([{ surfaceId, questionId: "answer" }]);
    expect(await call(decisionsDelete, { surfaceId, questionId: "answer" })).toMatchObject({ refusal: { code: "delivery-pending" } });
    const eligible = await store.create({ agentId: "agent", document: created.record.document! });
    if (!eligible.ok) throw Error(eligible.refusal.message);
    const eligibleId = eligible.record.id;
    await call(draftSet, { ...draft, surfaceId: eligibleId });
    await call(send, { surfaceId: eligibleId, targets: [{ target: "answer", version: 1 }] });
    expect((await store.apply(eligibleId, {
      kind: "updateDelivery", n: 1, to: "delivered", now: new Date().toISOString(),
    })).ok).toBe(true);
    expect(await call(decisionsDelete, { agentId: "agent" })).toEqual({
      refusal: { code: "delivery-pending", message: "Some decisions could not be deleted." },
    });
    expect(await call(decisionsSearch, { agentId: "agent" })).toMatchObject([{ surfaceId }]);
    const settled = await store.apply(surfaceId, { kind: "updateDelivery", n: 1, to: "delivered", now: new Date().toISOString() });
    if (!settled.ok || !settled.record.resolvedAt) throw new Error("Expected a resolved surface");
    const rev = settled.record.rev;
    clock = Date.parse(settled.record.resolvedAt) + 7 * 24 * 60 * 60 * 1000 + 1;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.at(-1)).toEqual({ kind: "change", hostId: "host-a", surfaceId, rev, summary: null });
    expect(store.get(surfaceId)).toBeDefined();

    expect(await call(decisionsDelete, { surfaceId, questionId: "answer" })).toEqual({});
    expect(await call(decisionsSearch, {})).toEqual([]);

    const standalone = await store.create({ agentId: "another-agent", document: created.record.document! });
    if (!standalone.ok) throw Error(standalone.refusal.message);
    const removableId = standalone.record.id;
    expect(await call(draftSet, { ...draft, surfaceId: removableId })).toEqual({ version: 1 });
    expect(await call(send, { surfaceId: removableId, targets: [{ target: "answer", version: 1 }] }))
      .toMatchObject({ delivery: { n: 1 } });
    expect((await store.apply(removableId, { kind: "updateDelivery", n: 1, to: "delivered", now: new Date().toISOString() })).ok).toBe(true);
    expect(await call(decisionsDelete, { surfaceId: removableId, questionId: "answer" })).toEqual({});
    expect(events.at(-1)).toMatchObject({
      kind: "change", hostId: "host-a", surfaceId: removableId, removed: true, summary: null,
    });
    expect(store.get(removableId)).toBeUndefined();

    controller.abort();
    await stream;
    expect(closed).toHaveBeenCalledOnce();
    const before = events.length;
    await store.create({ agentId: "after-abort", document: created.record.document! });
    expect(events).toHaveLength(before);
  } finally {
    controller.abort();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
