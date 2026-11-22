import type { PluginClientContext, PluginHostSummary } from "@getpaseo/plugin/client";
import { searchDecisions, type Summary } from "../shared/projections";
import { decisionsSearch, type SurfaceEvent } from "../shared/rpc";
import type { PluginRpcContract, RpcInput } from "@getpaseo/plugin";
import type { input, output, ZodType } from "zod";

type Rpc = PluginClientContext["rpc"];
type Source = { rpc: Rpc };
type HostEntry = {
  source?: Source;
  summaries: ReadonlyMap<string, Summary>;
  revisions: ReadonlyMap<string, string>;
  snapshotNumber: number;
  updatedAt: number;
  fresh: boolean;
};

export function createHub() {
  let snapshot: ReadonlyMap<string, HostEntry> = new Map();
  const listeners = new Set<() => void>();

  function set(hostId: string, entry: HostEntry) {
    snapshot = new Map(snapshot).set(hostId, entry);
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(source: Source, event: SurfaceEvent, now = Date.now()) {
      const prior = snapshot.get(event.hostId);
      if (event.kind === "snapshot") {
        set(event.hostId, {
          source,
          summaries: new Map(event.summaries.map((s) => [s.id, s])),
          revisions: new Map(event.summaries.map((s) => [s.id, String(s.rev)])),
          snapshotNumber: (prior?.snapshotNumber ?? 0) + 1,
          updatedAt: now,
          fresh: true,
        });
      } else if (prior?.source === source) {
        const summaries = new Map(prior.summaries);
        if (event.summary) summaries.set(event.surfaceId, event.summary);
        else summaries.delete(event.surfaceId);
        const revisions = new Map(prior.revisions);
        revisions.set(event.surfaceId, event.removed ? `removed:${event.rev}` : String(event.rev));
        set(event.hostId, { ...prior, summaries, revisions, updatedAt: now, fresh: true });
      }
    },
    unavailable(hostId: string, source: Source, detached = false) {
      const prior = snapshot.get(hostId);
      if (prior?.source === source) {
        set(hostId, { ...prior, fresh: false, source: detached ? undefined : source });
      }
    },
    sourceFor: (hostId: string) => snapshot.get(hostId)?.source,
  };
}

export type Hub = ReturnType<typeof createHub>;
const KEY = "__paseoDocketHub_v1";

export function getHub(): Hub {
  const realm = globalThis as typeof globalThis & { [KEY]?: Hub };
  return realm[KEY] ??= createHub();
}

export async function callHost<C extends PluginRpcContract<ZodType, ZodType<{ hostId: string; result: unknown }>>>(
  hub: Hub,
  hostId: string,
  contract: C,
  input: input<C["input"]>,
): Promise<output<C["output"]>["result"]> {
  const source = hub.sourceFor(hostId);
  if (!source) throw new Error(`Docket host ${hostId} is unavailable`);
  const reply = await source.rpc(contract, input) as output<C["output"]>;
  if (reply.hostId !== hostId) throw new Error("Docket RPC replied from the wrong host");
  return reply.result;
}

const DECISION_SEARCH_TIMEOUT_MS = 10_000;

export async function searchHostDecisions(hub: Hub, hostIds: readonly string[], query: RpcInput<typeof decisionsSearch>) {
  const sources = hostIds.map(hub.sourceFor);
  const results = await Promise.allSettled(hostIds.map(async (id) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Docket decision search timed out")), DECISION_SEARCH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([callHost(hub, id, decisionsSearch, query), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }));
  const unavailable: string[] = [];
  const decisions = results.flatMap((result, index) => {
    const hostId = hostIds[index];
    if (result.status === "fulfilled" && sources[index] === hub.sourceFor(hostId)) {
      return result.value.map((decision) => ({ ...decision, hostId }));
    }
    unavailable.push(hostId);
    return [];
  });
  return { decisions: searchDecisions(decisions, { limit: query.limit }), unavailable };
}

export function inboxOf(
  snapshot: ReturnType<Hub["getSnapshot"]>,
  hosts: readonly PluginHostSummary[],
  confirmedMissing?: ReadonlySet<string>,
  scope?: { hostId: string; workspaceId: string },
) {
  const sources = hosts.filter((host) => !scope || host.serverId === scope.hostId).map((host) => {
    const entry = snapshot.get(host.serverId);
    // The SDK reports host connectivity. Absence from the hub alone cannot establish absence of the plugin.
    const status = host.status !== "online" ? "disconnected"
      : entry?.source ? (entry.fresh ? "ready" : "stale")
      : confirmedMissing?.has(host.serverId) ? "missing"
      : entry ? "stale" : "pending";
    return { ...host, docketStatus: status, summaries: entry?.summaries, updatedAt: entry?.updatedAt };
  });
  const cards = sources.flatMap((host) => [...(host.summaries?.values() ?? [])]
    .filter((summary) => !scope || summary.workspaceId === scope.workspaceId)
    .map((summary) => ({
      hostId: host.serverId,
      summary,
      ...(host.docketStatus === "ready" ? {} : { staleSince: host.updatedAt }),
    })));
  const ready = sources.filter((host) => host.docketStatus === "ready");
  const readyIds = new Set(ready.map((host) => host.serverId));
  const open = cards.filter(({ hostId, summary }) => readyIds.has(hostId) && summary.status === "open").length;
  const incomplete = sources.some((host) => host.docketStatus !== "ready" && host.docketStatus !== "missing");
  const count = incomplete
    ? ready.length ? { kind: "lower-bound" as const, value: open } : { kind: "unknown" as const }
    : { kind: "exact" as const, value: open };
  return { sources, cards, count };
}
