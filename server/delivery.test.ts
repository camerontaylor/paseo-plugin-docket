import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDelivery } from "./delivery";
import type { PaseoApi, QueueSnapshot } from "./delivery-host";
import { openStore, type Store } from "./store";

const agentId = "agent-a";
let root: string;
let clock: number;
const now = () => new Date(clock);
const date = () => now().toISOString();
let store: Store;
let worker: ReturnType<typeof startDelivery> | undefined;

function fakePaseo(useQueue = true) {
  let revision = 0;
  let permission = false;
  let archived = false;
  let running = false;
  let exists = true;
  let conflict = false;
  const items = new Map<string, { deliveryState: QueueSnapshot["items"][number]["deliveryState"]; text: string }>();
  const messages = new Map<string, string>();
  const snapshot = (): QueueSnapshot => ({
    revision, items: [...items].map(([id, item]) => ({ id, deliveryState: item.deliveryState })),
  });
  const queue = {
    list: vi.fn(async () => snapshot()),
    enqueue: vi.fn(async ({ itemId, text }: { itemId: string; text: string; intent: "queue" }) => {
      if (!items.has(itemId) && !messages.has(itemId)) {
        items.set(itemId, { text, deliveryState: "pending" });
        revision++;
      }
      return snapshot();
    }),
    remove: vi.fn(async (id: string, expected: number) => {
      if (conflict) { conflict = false; revision++; }
      if (expected !== revision) throw new Error("queue_revision_conflict");
      items.delete(id);
      revision++;
      return snapshot();
    }),
    retry: vi.fn(async (id: string, expected: number) => {
      if (expected !== revision) throw new Error("queue_revision_conflict");
      items.get(id)!.deliveryState = "pending";
      revision++;
      return snapshot();
    }),
  };
  const send = vi.fn(async (text: string, options: { messageId: string; activeTurnBehavior: string }) => {
    if (archived || running || permission) throw new Error("unsafe send");
    messages.set(options.messageId, text);
  });
  const timeline = vi.fn(async () => ({
    epoch: "1", hasOlder: false, error: null,
    entries: [...messages].map(([clientMessageId, text]) => ({ item: { type: "user_message", clientMessageId, text } })),
  }));
  const agent = {
    id: agentId,
    refresh: async () => exists ? { agent: {
      archivedAt: archived ? date() : null, pendingPermissions: permission ? [{}] : [], status: running ? "running" : "idle",
    } } : null,
    send, timeline: { refetch: timeline }, ...(useQueue ? { queue } : {}),
  };
  return {
    paseo: { agents: { ref: () => agent } } as unknown as PaseoApi, items, messages, queue, send, timeline,
    permission: (value: boolean) => { permission = value; },
    archive: (value: boolean) => { archived = value; },
    running: (value: boolean) => { running = value; },
    missing: () => { exists = false; },
    conflict: () => { conflict = true; },
    drain(id: string) {
      if (archived || running || permission) return;
      const item = items.get(id);
      if (item?.deliveryState !== "pending") return;
      items.delete(id);
      revision++;
      messages.set(id, item.text);
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "docket-delivery-"));
  clock = Date.parse("2026-11-21T10:00:00Z");
  store = await openStore({ root, now });
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await rm(root, { recursive: true, force: true });
});

async function createDelivery() {
  const created = await store.create({
    agentId,
    document: { v: 1, summary: "Rollout", questions: [{ id: "choice", kind: "text", prompt: "Which?" }] },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const surface = created.record.id;
  const draft = await store.apply(surface, { kind: "setDraft", target: "choice", draft: { value: "blue" }, baseVersion: 0, now: date() });
  expect(draft.ok).toBe(true);
  const sent = await store.apply(surface, { kind: "send", targets: [{ target: "choice", version: 1 }], now: date() });
  if (!sent.ok || !sent.delivery) throw new Error(JSON.stringify(sent));
  return { surface, ...sent.delivery };
}

function start(host: ReturnType<typeof fakePaseo>, forceDirect = false) {
  worker = startDelivery(store, host.paseo, { now, forceDirect });
  return worker;
}

describe("queue transport", () => {
  it("recovers the record-before-enqueue gap, restarts with the item, and delivers once with its edited text", async () => {
    const d = await createDelivery();
    const host = fakePaseo();
    store = await openStore({ root, now });
    const first = start(host);
    await first.check(agentId);
    expect(store.get(d.surface)?.deliveries[0]).toMatchObject({ state: "queued", enqueued: true });
    expect(host.items.size).toBe(1);
    await first.stop();

    store = await openStore({ root, now });
    const restarted = start(host);
    host.items.get(d.messageId)!.text = "rewritten by the user";
    await restarted.check(agentId);
    host.drain(d.messageId);
    await restarted.check(agentId);
    expect(host.queue.enqueue).toHaveBeenCalledExactlyOnceWith({ itemId: d.messageId, intent: "queue", text: d.text });
    expect(host.messages.size).toBe(1);
    expect(store.get(d.surface)?.deliveries[0]).toMatchObject({ state: "delivered", receivedText: "rewritten by the user", text: d.text });
  });

  it("runs the startup sweep without an agent event once it has the host API", async () => {
    const d = await createDelivery();
    const host = fakePaseo(false);
    start(host);
    await vi.waitFor(() => expect(store.get(d.surface)?.deliveries[0].state).toBe("delivered"));
    expect(host.send).toHaveBeenCalledTimes(1);
  });

  it("recovers an accepted enqueue whose acknowledgement was lost", async () => {
    const d = await createDelivery();
    const host = fakePaseo();
    await host.queue.enqueue({ itemId: d.messageId, intent: "queue", text: d.text });
    host.queue.enqueue.mockClear();
    await start(host).check(agentId);
    expect(store.get(d.surface)?.deliveries[0].enqueued).toBe(true);
    expect(host.queue.enqueue).not.toHaveBeenCalled();
  });

  it("removes a confirmed uncertain blocker after a concurrent revision change", async () => {
    const d = await createDelivery();
    const host = fakePaseo();
    const delivery = start(host);
    await delivery.check(agentId);
    host.items.get(d.messageId)!.deliveryState = "uncertain";
    await delivery.check(agentId);
    expect(store.get(d.surface)?.deliveries[0].state).toBe("uncertain");
    host.messages.set(d.messageId, d.text);
    host.conflict();
    await delivery.check(agentId);
    expect(host.queue.remove).toHaveBeenCalledTimes(2);
    expect(host.items.size).toBe(0);
    expect(store.get(d.surface)?.deliveries[0].state).toBe("delivered");
  });

  it("leaves permission handling to the queue and records user deletion", async () => {
    const d = await createDelivery();
    const host = fakePaseo();
    host.permission(true);
    const delivery = start(host);
    await delivery.check(agentId);
    host.drain(d.messageId);
    expect(host.messages.size).toBe(0);
    expect(host.send).not.toHaveBeenCalled();
    await host.queue.remove(d.messageId, (await host.queue.list()).revision);
    await delivery.check(agentId);
    expect(store.get(d.surface)?.deliveries[0].state).toBe("removed");
    expect(host.queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("holds on archive, preserves the hold on restore and reuses the id on Retry", async () => {
    const d = await createDelivery();
    const host = fakePaseo();
    const delivery = start(host);
    await delivery.check(agentId);
    host.archive(true);
    await delivery.archive(agentId);
    expect(host.items.size).toBe(0);
    expect(store.get(d.surface)?.deliveries[0].state).toBe("held");
    host.archive(false);
    await delivery.check(agentId);
    expect(host.items.size).toBe(0);
    expect((await delivery.retry(d.surface, 1)).ok).toBe(true);
    await delivery.check(agentId);
    expect(host.items.has(d.messageId)).toBe(true);
    host.drain(d.messageId);
    await delivery.check(agentId);
    expect(store.get(d.surface)?.deliveries[0].state).toBe("delivered");
  });

  it("keeps archive cleanup pending across queue read errors and restart", async () => {
    const d = await createDelivery();
    const host = fakePaseo();
    const delivery = startDelivery(store, host.paseo, { now, onError: () => {} });
    worker = delivery;
    await delivery.check(agentId);
    host.archive(true);
    const list = host.queue.list.getMockImplementation()!;
    host.queue.list.mockRejectedValue(new Error("daemon unreachable"));
    await delivery.archive(agentId);
    expect(store.get(d.surface)?.deliveries[0]).toMatchObject({ state: "held", enqueued: true });
    await delivery.stop();
    host.queue.list.mockImplementation(list);

    store = await openStore({ root, now });
    host.archive(false);
    await start(host).check(agentId);
    expect(host.items.size).toBe(0);
    expect(store.get(d.surface)?.deliveries[0]).toMatchObject({ state: "held", enqueued: false });
    expect(host.queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("backs off enqueue errors and retries existing failed items only on explicit Retry", async () => {
    const d = await createDelivery();
    const host = fakePaseo();
    host.queue.enqueue.mockRejectedValueOnce(new Error("queue_full"));
    const delivery = start(host);
    await delivery.check(agentId);
    await delivery.check(agentId);
    expect(host.queue.enqueue).toHaveBeenCalledTimes(1);
    clock += 1_000;
    await delivery.check(agentId);
    host.items.get(d.messageId)!.deliveryState = "failed";
    await delivery.check(agentId);
    expect(store.get(d.surface)?.deliveries[0].state).toBe("failed");
    expect(host.queue.retry).not.toHaveBeenCalled();
    expect((await delivery.retry(d.surface, 1)).ok).toBe(true);
    await delivery.check(agentId);
    expect(host.queue.retry).toHaveBeenCalledTimes(1);
    expect(host.items.get(d.messageId)?.deliveryState).toBe("pending");
  });

  it("removes a queued item found archived on restart before accepting a retry", async () => {
    const d = await createDelivery();
    const host = fakePaseo();
    await host.queue.enqueue({ itemId: d.messageId, intent: "queue", text: d.text });
    host.archive(true);
    const delivery = start(host);
    await delivery.check(agentId);
    expect(host.items.size).toBe(0);
    expect(store.get(d.surface)?.deliveries[0].state).toBe("held");
    expect((await delivery.retry(d.surface, 1)).ok).toBe(false);
  });
});

describe("direct transport", () => {
  it.each(["stock", "unsupported", "forced"])("delivers only to a ready agent (%s)", async (mode) => {
    const d = await createDelivery();
    const host = fakePaseo(mode !== "stock");
    if (mode === "unsupported") host.queue.list.mockRejectedValue(Object.assign(new Error("no feature"), { code: "AGENT_QUEUE_UNSUPPORTED" }));
    host.running(true);
    host.permission(true);
    const delivery = start(host, mode === "forced");
    await delivery.check(agentId);
    host.running(false);
    await delivery.check(agentId);
    expect(host.send).not.toHaveBeenCalled();
    host.permission(false);
    await delivery.check(agentId);
    await delivery.check(agentId);
    expect(host.send).toHaveBeenCalledExactlyOnceWith(d.text, { messageId: d.messageId, activeTurnBehavior: "steer" });
    expect(store.get(d.surface)?.deliveries[0].state).toBe("delivered");
    expect(host.queue.enqueue).not.toHaveBeenCalled();
  });

  it("uses the same frozen request for five attempts and fails absent agents immediately", async () => {
    const d = await createDelivery();
    const host = fakePaseo(false);
    host.send.mockRejectedValue(new Error("offline"));
    const delivery = start(host);
    for (const delay of [0, 1_000, 2_000, 4_000, 8_000]) {
      clock += delay;
      await delivery.check(agentId);
    }
    expect(host.send.mock.calls).toEqual(Array(5).fill([d.text, { messageId: d.messageId, activeTurnBehavior: "steer" }]));
    expect(store.get(d.surface)?.deliveries[0]).toMatchObject({ state: "failed", attempts: 5 });
    host.missing();
    const missing = await createDelivery();
    await delivery.check(agentId);
    expect(store.get(missing.surface)?.deliveries[0]).toMatchObject({ state: "failed", attempts: 0 });
  });

  it.each([false, true])("checks the timeline before Retry of an unknown direct outcome (found: %s)", async (found) => {
    const d = await createDelivery();
    const host = fakePaseo(false);
    host.send.mockRejectedValueOnce(new Error("agent_request_outcome_unknown"));
    const delivery = start(host);
    await delivery.check(agentId);
    expect(store.get(d.surface)?.deliveries[0].state).toBe("uncertain");
    if (found) host.messages.set(d.messageId, d.text);
    expect((await delivery.retry(d.surface, 1)).ok).toBe(!found);
    await delivery.check(agentId);
    await delivery.check(agentId);
    expect(host.send).toHaveBeenCalledTimes(found ? 1 : 2);
    expect(store.get(d.surface)?.deliveries[0]).toMatchObject({ state: "delivered", messageId: found ? d.messageId : d.messageId + ":g1" });
  });
});

it("protects a failed delivery from deletion until the composer removes its item", async () => {
  const d = await createDelivery();
  const host = fakePaseo();
  const delivery = start(host);
  await delivery.check(agentId);
  host.items.get(d.messageId)!.deliveryState = "failed";
  await delivery.check(agentId);

  expect(await store.deleteDecision(d.surface, "choice"))
    .toMatchObject({ ok: false, refusal: { code: "delivery-pending" } });
  expect(store.get(d.surface)?.deliveries[0]).toMatchObject({ state: "failed", text: d.text });
  expect(host.items.get(d.messageId)?.text).toBe(d.text);

  await host.queue.remove(d.messageId, (await host.queue.list()).revision);
  await delivery.check(agentId);
  expect(await store.deleteDecision(d.surface, "choice")).toMatchObject({ ok: true });
  host.drain(d.messageId);
  expect(host.messages.size).toBe(0);
});

it("refuses Retry when a persisted queue delivery has no queue handle", async () => {
  const d = await createDelivery();
  const host = fakePaseo();
  const delivery = start(host);
  await delivery.check(agentId);
  host.items.get(d.messageId)!.deliveryState = "failed";
  await delivery.check(agentId);
  await delivery.stop();

  const stock = fakePaseo(false);
  worker = startDelivery(store, stock.paseo, { now, onError: () => {} });
  expect(await worker.retry(d.surface, 1)).toMatchObject({ ok: false, refusal: { code: "queue-unavailable" } });
  expect(store.get(d.surface)?.deliveries[0]).toMatchObject({ state: "failed", enqueued: true });
  expect(stock.send).not.toHaveBeenCalled();
});

it("offers explicit same-ID Retry when a direct acknowledgement has no timeline entry", async () => {
  const d = await createDelivery();
  const host = fakePaseo(false);
  host.send.mockResolvedValue(undefined);
  const delivery = start(host);
  await delivery.check(agentId);
  clock += 60_000;
  await delivery.check(agentId);
  await delivery.check(agentId);
  expect(store.get(d.surface)?.deliveries[0]).toMatchObject({ state: "uncertain", sent: true });
  expect(host.send).toHaveBeenCalledTimes(1);

  expect(await delivery.retry(d.surface, 1)).toMatchObject({ ok: true });
  await delivery.check(agentId);
  expect(host.send.mock.calls).toEqual(Array(2).fill([d.text, { messageId: d.messageId, activeTurnBehavior: "steer" }]));
});
