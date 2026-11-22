import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { commentSet, decisionsDelete, decisionsSearch, deliveryRetry, draftSet, evidenceCheck, evidenceGet, send, surfaceGet, surfaces, surfacesList, type SurfaceEvent } from "../shared/rpc";
import { hasOwn } from "../shared/transitions";
import type { Store, StoreResult } from "./store";
import type { startDelivery } from "./delivery";
import type { PaseoApi } from "./delivery-host";
import { LIMITS } from "../shared/limits";
import { agentStorage } from "./tools";
import { readEvidence, snapshotStatus } from "./evidence/store";

function saved<T>(result: StoreResult, success: (record: Extract<StoreResult, { ok: true }>["record"]) => T) {
  if (result.ok) return success(result.record);
  if (result.refusal.code === "stale-draft") return { conflict: result.refusal.current ?? null };
  return { refusal: result.refusal };
}

export function registerRpc(
  server: PluginServerContext,
  getStore: () => Promise<Store>,
  connectDelivery: (paseo: PaseoApi) => Promise<Pick<ReturnType<typeof startDelivery>, "retry">>,
  readSettings?: () => Promise<{ extraFolders: string[] }>,
) {
  let identity: Promise<string> | undefined;
  function identify(paseo: PaseoApi) {
    return identity ??= paseo.hosts.list().then(({ self }) => {
      if (!self.serverId) throw new Error("Docket could not identify this host");
      return self.serverId;
    }).catch((error: unknown) => {
      identity = undefined;
      throw error;
    });
  }

  async function reply<T>(paseo: PaseoApi, run: (store: Store) => T | Promise<T>) {
    const [hostId, store] = await Promise.all([identify(paseo), getStore()]);
    return { hostId, result: await run(store) };
  }

  server.handle(surfaces, async (_, { paseo, push, signal }) => {
    const [hostId, store] = await Promise.all([identify(paseo), getStore()]);
    if (signal.aborted) return;

    void connectDelivery(paseo).catch(() => console.warn("[docket] delivery startup failed"));
    const initial = store.summaries();
    const visible = new Map(initial.map((summary) => [summary.id, summary]));

    // Paseo closes a subscription when its async handler settles.
    return new Promise<void>((resolve, reject) => {
      function sendEvent(event: SurfaceEvent) {
        void push(event).catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      }

      // The rolling retention cutoff can pass without a store write.
      const expiry = setInterval(() => {
        for (const [surfaceId, { rev, status }] of visible) {
          if (status !== "resolved" || store.summary(surfaceId)) continue;
          visible.delete(surfaceId);
          sendEvent({ kind: "change", hostId, surfaceId, rev, summary: null });
        }
      }, 60_000);
      expiry.unref();

      const unsubscribe = store.onChange(({ surfaceId, rev, removed }) => {
        const summary = removed ? null : store.summary(surfaceId) ?? null;
        if (summary) visible.set(surfaceId, summary);
        else visible.delete(surfaceId);
        sendEvent({ kind: "change", hostId, surfaceId, rev, summary, ...(removed ? { removed } : {}) });
      });

      function cleanup() {
        unsubscribe();
        clearInterval(expiry);
        signal.removeEventListener("abort", stop);
      }

      function stop() {
        cleanup();
        resolve();
      }

      signal.addEventListener("abort", stop, { once: true });
      sendEvent({ kind: "snapshot", hostId, summaries: initial });
    });
  });
  server.handle(surfacesList, (_, { paseo }) => reply(paseo, (store) => {
    void connectDelivery(paseo).catch(() => console.warn("[docket] delivery startup failed"));
    return store.summaries();
  }));
  server.handle(surfaceGet, ({ surfaceId }, { paseo }) => reply(paseo, (store) => store.get(surfaceId) ?? null));
  server.handle(evidenceGet, ({ surfaceId, snapshotId }, { paseo }) => reply(paseo, (store) => {
    const record = store.get(surfaceId);
    return record && hasOwn(record.snapshots, snapshotId) ? readEvidence(store.root, surfaceId, snapshotId) : null;
  }));
  server.handle(evidenceCheck, ({ surfaceId, snapshotId }, { paseo }) => reply(paseo, async (store): Promise<RpcOutput<typeof evidenceCheck>["result"]> => {
    const record = store.get(surfaceId);
    if (!record?.document || !hasOwn(record.snapshots, snapshotId)) return { status: "unavailable" };
    const snapshot = record.snapshots[snapshotId];
    const kind = snapshot.kind;
    if (kind !== "file" && kind !== "changes") return { status: "unavailable" };
    try {
      const agent = paseo.agents.ref(record.agentId);
      if (!await agent.refresh()) return { status: "unavailable" };
      const cwd = agent.cwd;
      if (!cwd || agent.workspaceId !== record.workspaceId || (snapshot.cwd !== undefined && snapshot.cwd !== cwd)) {
        return { status: "unavailable" };
      }
      const settings = await readSettings?.();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LIMITS.evidenceBudgetMs);
      try {
        const result = await snapshotStatus({ ...snapshot, kind }, {
          cwd,
          extraRoots: [agentStorage(record.agentId), "/tmp", ...(settings?.extraFolders ?? [])],
          signal: controller.signal,
          includeCurrentRef: true,
        });
        return controller.signal.aborted ? { status: "unavailable" } : result;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { status: "unavailable" };
    }
  }));
  server.handle(draftSet, ({ surfaceId, ...fields }, { paseo }) => reply(paseo, async (store) => {
    const result = await store.apply(surfaceId, { kind: "setDraft", ...fields, now: new Date().toISOString() });
    return saved(result, (record) => ({ version: record.drafts[fields.target].version }));
  }));
  server.handle(commentSet, ({ surfaceId, ...fields }, { paseo }) => reply(paseo, async (store) => {
    const result = await store.apply(surfaceId, { kind: "setComment", ...fields, now: new Date().toISOString() });
    return saved(result, (record) => ({ version: record.comments[fields.on].version }));
  }));
  server.handle(send, ({ surfaceId, ...fields }, { paseo }) => reply(paseo, async (store) => {
    await connectDelivery(paseo);
    const result = await store.apply(surfaceId, { kind: "send", ...fields, now: new Date().toISOString() });
    if (result.ok) return { delivery: result.delivery ?? null };
    const { refusal } = result;
    if (refusal.code === "stale-send") return { conflict: refusal.conflicts ?? [] };
    if (refusal.code === "closed") return { closed: true as const };
    return { refusal };
  }));
  server.handle(deliveryRetry, ({ surfaceId, n }, { paseo }) => reply(paseo, async (): Promise<RpcOutput<typeof deliveryRetry>["result"]> => {
    const result = await (await connectDelivery(paseo)).retry(surfaceId, n);
    return result.ok ? {} : { refusal: result.refusal };
  }));
  server.handle(decisionsSearch, ({ query, ...filter }, { paseo }) => reply(paseo, (store) => store.decisions({ ...filter, text: query })));
  server.handle(decisionsDelete, (input, { paseo }) => reply(paseo, async (store): Promise<RpcOutput<typeof decisionsDelete>["result"]> => {
    if ("agentId" in input) {
      await store.deleteAgentDecisions(input.agentId);
      if (store.decisions({ agentId: input.agentId, limit: 1 }).length) {
        return { refusal: { code: "delivery-pending", message: "Some decisions could not be deleted." } };
      }
      return {};
    }
    const result = await store.deleteDecision(input.surfaceId, input.questionId);
    return result.ok ? {} : { refusal: result.refusal };
  }));
}
