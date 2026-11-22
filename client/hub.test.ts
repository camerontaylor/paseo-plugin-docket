import type { PluginClientContext, PluginHostSummary } from "@getpaseo/plugin/client";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { Decision, Summary } from "../shared/projections";
import { decisionsSearch, draftSet, type SurfaceEvent } from "../shared/rpc";
import { callHost, createHub, inboxOf, searchHostDecisions } from "./hub";
import { startSource } from "./source";

const host = (serverId: string, status: PluginHostSummary["status"] = "online"): PluginHostSummary =>
  ({ serverId, status, label: serverId });

const card: Summary = {
  id: "s_aaaaaa", rev: 1, agentId: "agent", workspaceId: null, summary: "Review",
  status: "open", createdAt: "2026-11-22T00:00:00Z", resolvedAt: null, openQuestions: 1,
  pendingDeliveries: 0, replacedBy: null, revises: null, compacted: false,
};

function fakeClient(hostId: string) {
  const streams: { emit: (event: SurfaceEvent) => void; close: () => void; release: () => Promise<void> }[] = [];
  const rpc = vi.fn(async (contract: unknown) => ({
    hostId,
    result: contract === draftSet ? { version: 1 } : contract === decisionsSearch ? [decision] : [card],
  }));
  const subscribe = vi.fn((
    _contract: unknown,
    _input: unknown,
    emit: (event: SurfaceEvent) => void,
    { onClosed }: { onClosed: (state: object) => void },
  ) => {
    const release = vi.fn(async () => {});
    streams.push({ emit, close: () => onClosed({}), release });
    return Object.assign(release, { release, ready: Promise.resolve() });
  });
  return { rpc, streams, transport: { rpc, subscribe } as unknown as Pick<PluginClientContext, "rpc" | "subscribe"> };
}

const decision: Decision = {
  surfaceId: card.id, questionId: "text", summary: card.summary, context: null,
  agentId: card.agentId, workspaceId: null, kind: "text", prompt: "What?", label: "Answer",
  at: card.createdAt, delivery: null, deliveryState: null,
};

const initial = (hostId: string): SurfaceEvent => ({ hostId, kind: "snapshot", summaries: [card] });
afterEach(() => vi.useRealTimers());

it("merges sources with overlapping ids and routes an edit to its own host", async () => {
  const hub = createHub();
  const a = fakeClient("a");
  const b = fakeClient("b");
  const stopA = startSource(a.transport, hub);
  const stopB = startSource(b.transport, hub);
  expect(hub.getSnapshot().size).toBe(0);
  const pending = () => inboxOf(hub.getSnapshot(), [host("a"), host("b")]);
  expect(pending().count).toEqual({ kind: "unknown" });
  a.streams[0].emit(initial("a"));
  expect(pending().sources[1].docketStatus).toBe("pending");
  expect(pending().count).toEqual({ kind: "lower-bound", value: 1 });
  b.streams[0].emit(initial("b"));
  const view = () => inboxOf(hub.getSnapshot(), [host("a"), host("b"), host("c")], new Set(["c"]));
  expect(view().cards.map(({ hostId }) => hostId)).toEqual(["a", "b"]);
  expect(view().sources[2].docketStatus).toBe("missing");
  expect(view().count).toEqual({ kind: "exact", value: 2 });

  const args = { surfaceId: card.id, target: "text", baseVersion: 0, draft: { value: "answer" } };
  await expect(callHost(hub, "b", draftSet, args)).resolves.toEqual({ version: 1 });
  expect(a.rpc).not.toHaveBeenCalled();
  expect(b.rpc).toHaveBeenCalledWith(draftSet, args);

  stopB();
  const offline = inboxOf(hub.getSnapshot(), [host("a"), host("b", "offline")]);
  expect(offline.cards[1]).toMatchObject({ hostId: "b", staleSince: expect.any(Number) });
  expect(offline.count).toEqual({ kind: "lower-bound", value: 1 });
  await expect(callHost(hub, "b", draftSet, args)).rejects.toThrow("unavailable");
  stopA();
  expect(inboxOf(hub.getSnapshot(), [host("b", "error")]).count).toEqual({ kind: "unknown" });
  expect(inboxOf(createHub().getSnapshot(), [host("never-seen", "error")]).count).toEqual({ kind: "unknown" });
});

it("polls with backoff after a drop, then accepts a replacement snapshot", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const hub = createHub();
  const client = fakeClient("a");
  const stop = startSource(client.transport, hub);
  client.streams[0].emit(initial("a"));
  const before = hub.getSnapshot();
  expect(hub.getSnapshot()).toBe(before);
  client.streams[0].emit({ hostId: "a", kind: "change", surfaceId: card.id, rev: 2, summary: { ...card, rev: 2 } });
  expect(hub.getSnapshot().get("a")?.revisions.get(card.id)).toBe("2");
  client.streams[0].close();
  expect(inboxOf(hub.getSnapshot(), [host("a")]).cards[0].staleSince).toBe(100_000);

  client.rpc.mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.rpc).toHaveBeenCalledTimes(1);
  client.streams[1].close();
  await vi.advanceTimersByTimeAsync(1999);
  expect(client.rpc).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(client.rpc).toHaveBeenCalledTimes(2);
  client.streams[2].emit({ hostId: "a", kind: "snapshot", summaries: [] });
  expect(inboxOf(hub.getSnapshot(), [host("a")]).count).toEqual({ kind: "exact", value: 0 });
  expect(hub.getSnapshot().get("a")?.revisions.has(card.id)).toBe(false);
  stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(client.rpc).toHaveBeenCalledTimes(2);
});

it("keeps the host id on merged decision results through the global limit", async () => {
  const hub = createHub();
  const a = fakeClient("a");
  const b = fakeClient("b");
  const stopA = startSource(a.transport, hub);
  const stopB = startSource(b.transport, hub);
  a.streams[0].emit(initial("a"));
  b.streams[0].emit(initial("b"));
  const result = await searchHostDecisions(hub, ["b", "a"], { limit: 1 });
  expectTypeOf(result.decisions[0].hostId).toEqualTypeOf<string>();
  expect(result).toEqual({ decisions: [{ ...decision, hostId: "b" }], unavailable: [] });
  stopA();
  stopB();
});

it("retries streams while one poll is stalled and ignores its late result", async () => {
  vi.useFakeTimers();
  const hub = createHub();
  const client = fakeClient("a");
  let finishPoll!: (result: { hostId: string; result: Summary[] }) => void;
  client.rpc.mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve; }));
  const stop = startSource(client.transport, hub);
  client.streams[0].close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.rpc).toHaveBeenCalledTimes(1);
  expect(inboxOf(hub.getSnapshot(), [host("a")]).count).toEqual({ kind: "unknown" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(client.streams).toHaveLength(2);
  client.streams[1].close();
  await vi.advanceTimersByTimeAsync(2000);
  expect(client.streams).toHaveLength(3);
  expect(client.rpc).toHaveBeenCalledTimes(1);
  client.streams[2].emit(initial("a"));
  finishPoll({ hostId: "a", result: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(inboxOf(hub.getSnapshot(), [host("a")]).count).toEqual({ kind: "exact", value: 1 });
  expect(client.streams).toHaveLength(3);
  stop();
});

it("uses a slow poll result if the replacement stream has not caught up", async () => {
  vi.useFakeTimers();
  const hub = createHub();
  const client = fakeClient("a");
  client.rpc.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
    return { hostId: "a", result: [card] };
  });
  const stop = startSource(client.transport, hub);
  client.streams[0].close();
  await vi.advanceTimersByTimeAsync(11_000);
  expect(client.streams).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(inboxOf(hub.getSnapshot(), [host("a")]).count).toEqual({ kind: "exact", value: 1 });
  expect(client.streams).toHaveLength(2);
  stop();
});
