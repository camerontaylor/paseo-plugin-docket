import { deliveryAction, type AgentDeliveryState, type DeliveryTransport } from "../shared/delivery";
import type { Delivery, SurfaceRecord } from "../shared/record";
import type { DeliveryPatch } from "../shared/transitions";
import { hasErrorCode, queueOf, selectTransport, timelineText, type DeliveryAgent, type PaseoApi, type QueueSnapshot } from "./delivery-host";
import type { Store } from "./store";

const OUTCOME_UNKNOWN = "agent_request_outcome_unknown";
const DIRECT_ATTEMPTS = 5;
const POLL_MS = 30_000;
const DIRECT_CONFIRMATION_MS = 60_000;
const TIMELINE_UNCONFIRMED = "timeline_unconfirmed";

interface DeliveryOptions {
  forceDirect?: boolean;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

function missing(error: unknown, id: string): boolean {
  return hasErrorCode(error, "agent_not_found") || hasErrorCode(error, `Agent not found: ${id}`);
}

function backoff(attempts: number): number {
  return Math.min(POLL_MS, 1_000 * 2 ** Math.min(attempts - 1, 5));
}

function nextMessageId(id: string): string {
  const match = /:g(\d+)$/.exec(id);
  return match ? id.slice(0, match.index) + `:g${Number(match[1]) + 1}` : id + ":g1";
}

export function startDelivery(store: Store, paseo: PaseoApi, options: DeliveryOptions = {}) {
  const now = options.now ?? (() => new Date());
  const report = options.onError ?? (() => console.warn("[docket] delivery check failed; will check again"));
  const lanes = new Map<string, Promise<unknown>>();
  const scheduled = new Set<string>();
  const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  let stopped = false;
  let transportSelection: Promise<DeliveryTransport> | undefined;

  function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const task = (lanes.get(id) ?? Promise.resolve()).then(fn);
    const tail = task.catch(() => undefined);
    lanes.set(id, tail);
    void tail.then(() => {
      if (lanes.get(id) === tail) lanes.delete(id);
    });
    return task;
  }

  function transportFor(agent: DeliveryAgent, d: Delivery): Promise<DeliveryTransport> {
    if (d.transport) return Promise.resolve(d.transport);
    if (d.enqueued || d.queueRetryRevision !== undefined) return Promise.resolve("queue");
    if (options.forceDirect) return Promise.resolve("direct");
    return transportSelection ??= selectTransport(agent).catch((error: unknown) => {
      transportSelection = undefined;
      throw error;
    });
  }

  function update(record: SurfaceRecord, d: Delivery, to?: Delivery["state"], patch?: DeliveryPatch) {
    return store.apply(record.id, { kind: "updateDelivery", n: d.n, messageId: d.messageId, to, patch, now: now().toISOString() });
  }

  function checkLater(id: string, at: number): void {
    if (stopped) return;
    const existing = timers.get(id);
    if (existing && existing.at <= at) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      timers.delete(id);
      schedule(id);
    }, Math.max(0, at - now().getTime()));
    timer.unref();
    timers.set(id, { at, timer });
  }

  async function removeItem(agent: DeliveryAgent, id: string, snapshot: QueueSnapshot, uncertainOnly: boolean) {
    const queue = queueOf(agent)!;
    // A concurrent user edit invalidates the revision. Re-evaluate the item before removing it.
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = snapshot.items.find((entry) => entry.id === id);
      if (!item || (uncertainOnly && item.deliveryState !== "uncertain")) return true;
      if (item.deliveryState === "dispatching") return false;
      try {
        await queue.remove(id, snapshot.revision);
        return true;
      } catch (error) {
        if (!hasErrorCode(error, "queue_revision_conflict")) throw error;
        snapshot = await queue.list();
      }
    }
    return false;
  }

  async function reconcileDelivery(record: SurfaceRecord, d: Delivery, agent: DeliveryAgent, state: AgentDeliveryState) {
    if (!d.text || d.state === "removed" || (d.state === "failed" && !d.enqueued)) return;
    if (state === "missing") {
      if (d.state === "queued" || d.state === "uncertain") await update(record, d, "failed", { lastError: "agent_not_found", queueRetryRevision: null });
      return;
    }

    const transport = await transportFor(agent, d);
    const queue = transport === "queue" ? queueOf(agent) : undefined;
    if (transport === "queue" && !queue) throw new Error("Durable queue handle unavailable");
    if (d.state === "delivered" && (!queue || !d.enqueued)) return;
    if (d.state === "held" && !d.enqueued && !d.transport) return;

    const snapshot = await queue?.list();
    const item = snapshot?.items.find((entry) => entry.id === d.messageId);
    // A queue read precedes the timeline read so a drained item has a chance to appear there.
    const received = d.state !== "delivered" && (!item || item.deliveryState === "uncertain" || state === "archived" || d.state === "held")
      ? await timelineText(agent, d.messageId) : undefined;
    if (stopped || store.get(record.id)?.deliveries.find((entry) => entry.n === d.n) !== d) return;

    const at = d.attempts > 0 && d.updatedAt ? Date.parse(d.updatedAt) + backoff(d.attempts) : 0;
    const retryDue = now().getTime() >= at;
    const confirmationAt = Date.parse(d.updatedAt ?? d.createdAt) + DIRECT_CONFIRMATION_MS;
    const action = deliveryAction({
      delivery: d, transport, agent: state, item: item?.deliveryState ?? "absent",
      inTimeline: received !== undefined, retryDue, confirmationExpired: now().getTime() >= confirmationAt,
    });
    switch (action) {
      case "deliver":
      case "deliverAndRemove": {
        // Keep an uncertain delivery protected from redaction until its queue
        // blocker is gone. A restart can still confirm it from the timeline.
        if (action === "deliverAndRemove" && !await removeItem(agent, d.messageId, snapshot!, true)) return;
        await update(record, d, "delivered", { receivedText: received, lastError: null, enqueued: false, queueRetryRevision: null });
        return;
      }
      case "hold":
        if (item && !d.enqueued) await update(record, d, undefined, { transport, enqueued: true, queueRetryRevision: null });
        return;
      case "removeHeld":
        if (item && !d.enqueued) await update(record, d, undefined, { enqueued: true });
        if (await removeItem(agent, d.messageId, snapshot!, false)) await update(record, d, undefined, { enqueued: false });
        return;
      case "uncertain":
        if (transport === "direct") {
          await update(record, d, "uncertain", { lastError: TIMELINE_UNCONFIRMED });
          return;
        }
        // The daemon still owns the uncertain queue item.
        await update(record, d, "uncertain", { transport, enqueued: true, queueRetryRevision: null });
        return;
      case "failQueue":
        await update(record, d, "failed", { transport, enqueued: true, queueRetryRevision: null });
        return;
      case "remove":
        await update(record, d, "removed", { enqueued: false, queueRetryRevision: null });
        return;
      case "retryQueue":
        // An advanced revision on recovery may already include the user's retry.
        // Never retry a second uncertain provider outcome on the same click.
        if (d.queueRetryRevision === snapshot!.revision) {
          try {
            await queue!.retry(d.messageId, snapshot!.revision);
          } catch (error) {
            if (!hasErrorCode(error, "queue_revision_conflict")) throw error;
            schedule(record.agentId);
            return;
          }
          await update(record, d, undefined, { transport, enqueued: true, queueRetryRevision: null });
        } else {
          await update(record, d, item!.deliveryState === "uncertain" ? "uncertain" : "failed", { transport, enqueued: true, queueRetryRevision: null });
        }
        return;
      case "enqueue":
      case "send":
        await attempt(record, d, agent, transport);
        return;
      case "wait":
        if (item && !d.enqueued) await update(record, d, undefined, { transport, enqueued: true, queueRetryRevision: null });
        if (d.state === "delivered" && d.enqueued) await update(record, d, undefined, { enqueued: false });
        if (transport === "direct" && d.state === "queued" && d.sent && Number.isFinite(confirmationAt)) {
          checkLater(record.agentId, confirmationAt);
        }
        if (!retryDue && d.state === "queued" && !d.enqueued && !d.sent) checkLater(record.agentId, at);
        return;
      case "failMissing":
        return; // Handled before reading a missing agent's timeline.
    }
  }

  async function snapshotOf(agent: DeliveryAgent): Promise<AgentDeliveryState> {
    try {
      const result = await agent.refresh();
      if (!result) return "missing";
      const { archivedAt, pendingPermissions, status } = result.agent;
      if (archivedAt) return "archived";
      return status === "idle" && pendingPermissions.length === 0 ? "ready" : "busy";
    } catch (error) {
      if (missing(error, agent.id)) return "missing";
      throw error;
    }
  }

  async function attempt(record: SurfaceRecord, d: Delivery, agent: DeliveryAgent, transport: DeliveryTransport) {
    // Persist the transport before crossing the host boundary, even if the
    // process dies before recording whether the call succeeded.
    const claim = await update(record, d, undefined, transport === "queue" ? { transport, enqueued: null } : { transport });
    if (!claim.ok || stopped) return;
    const current = claim.record.deliveries.find((entry) => entry.n === d.n);
    if (current?.state !== "queued" || current.text !== d.text
      || store.get(record.id)?.deliveries.find((entry) => entry.n === d.n) !== current) return;

    if (transport === "direct") {
      // Keep this refresh next to send: the stock API has no atomic idle fence.
      const state = await snapshotOf(agent);
      if (state === "missing") await update(record, d, "failed", { lastError: "agent_not_found" });
      if (state !== "ready" || stopped || store.get(record.id)?.deliveries.find((entry) => entry.n === d.n) !== current) return;
    }

    const attempts = d.attempts + 1;
    try {
      if (transport === "queue") await queueOf(agent)!.enqueue({ itemId: d.messageId, text: d.text, intent: "queue" });
      else await agent.send(d.text, { messageId: d.messageId, activeTurnBehavior: "steer" });
    } catch (error) {
      const unknown = transport === "direct" && hasErrorCode(error, OUTCOME_UNKNOWN);
      const gone = missing(error, agent.id);
      const failed = gone || (transport === "direct" && attempts >= DIRECT_ATTEMPTS);
      await update(record, d, unknown ? "uncertain" : failed ? "failed" : undefined, {
        attempts, lastError: unknown ? OUTCOME_UNKNOWN : gone ? "agent_not_found" : transport === "queue" ? "enqueue_failed" : "send_failed",
      });
      if (unknown) schedule(record.agentId);
      else if (!failed) checkLater(record.agentId, now().getTime() + backoff(attempts));
      return;
    }
    await update(record, d, undefined, { attempts, lastError: null, ...(transport === "queue" ? { enqueued: true } : { sent: true }) });
    schedule(record.agentId);
  }

  async function reconcile(id: string, archivedEvent = false): Promise<void> {
    if (stopped) return;
    const agent = paseo.agents.ref(id);
    const actualState = archivedEvent ? "archived" : await snapshotOf(agent);
    for (const record of store.list({ agentId: id })) {
      if (stopped) return;
      if (actualState !== "archived" && actualState !== "missing" && record.orphanedAt) {
        await store.apply(record.id, { kind: "agentRestored", now: now().toISOString() });
      }
      let checked = true;
      for (const d of record.deliveries) {
        try {
          await reconcileDelivery(record, d, agent, actualState);
        } catch (error) {
          checked = false;
          report(error);
        }
      }
      // Preserve archive intent even if the queue is temporarily unreachable.
      if (actualState === "archived") {
        const held = await store.apply(record.id, { kind: "holdOnArchive", now: now().toISOString() });
        if (held.ok && checked) {
          for (const d of held.record.deliveries.filter((entry) => entry.state === "held")) {
            await reconcileDelivery(held.record, d, agent, actualState);
          }
        }
      }
    }
  }

  function schedule(id: string): void {
    if (stopped || scheduled.has(id)) return;
    scheduled.add(id);
    void serial(id, async () => {
      scheduled.delete(id);
      await reconcile(id);
    }).catch(report);
  }

  function sweep(): void {
    const candidates = store.list().filter((record) => record.orphanedAt || record.deliveries.some((d) =>
      d.state === "queued" || d.state === "uncertain" || (d.enqueued && d.state !== "removed") || (d.state === "held" && d.transport)));
    for (const id of new Set(candidates.map((record) => record.agentId))) schedule(id);
  }

  const unsubscribe = store.onChange(({ surfaceId }) => {
    const record = store.get(surfaceId);
    if (record?.deliveries.some((d) => d.state === "queued")) schedule(record.agentId);
  });
  const poll = setInterval(sweep, POLL_MS);
  poll.unref();
  const startup = setTimeout(sweep, 0);
  startup.unref();

  return {
    check: (id: string) => serial(id, () => reconcile(id)),
    archive: (id: string) => serial(id, () => reconcile(id, true)),
    async retry(surfaceId: string, n: number) {
      const record = store.get(surfaceId);
      if (!record) return store.apply(surfaceId, { kind: "retryDelivery", n, now: now().toISOString() });
      return serial(record.agentId, async () => {
        const agent = paseo.agents.ref(record.agentId);
        await reconcile(record.agentId);
        const d = store.get(surfaceId)?.deliveries.find((entry) => entry.n === n);
        let queueRetryRevision: number | undefined;
        let messageId: string | undefined;
        if (d?.text && (d.state === "uncertain" || d.state === "failed" || d.state === "held" || d.state === "removed")) {
          const transport = await transportFor(agent, d);
          if (transport === "queue" && (d.enqueued || d.transport === "queue")) {
            const queue = queueOf(agent);
            const unavailable = () => ({
              ok: false as const,
              refusal: { code: "queue-unavailable" as const, message: "Retry requires the host's durable agent queue" },
            });
            if (!queue) return unavailable();
            const snapshot = await queue.list().catch((error: unknown) => {
              if (hasErrorCode(error, "AGENT_QUEUE_UNSUPPORTED")) return null;
              throw error;
            });
            if (!snapshot) return unavailable();
            const item = snapshot.items.find((entry) => entry.id === d.messageId);
            if (item && (d.state === "held" || d.state === "removed")) {
              throw new Error("The old delivery is still in the agent queue");
            }
            if (item) queueRetryRevision = snapshot.revision;
          } else if (transport === "direct" && (d.lastError === OUTCOME_UNKNOWN || d.sent)) {
            const receivedText = await timelineText(agent, d.messageId);
            if (receivedText !== undefined) {
              await update(record, d, "delivered", { receivedText, lastError: null });
            } else if (d.lastError === OUTCOME_UNKNOWN) {
              messageId = nextMessageId(d.messageId);
            }
          }
        }
        return store.apply(surfaceId, { kind: "retryDelivery", n, messageId, queueRetryRevision, now: now().toISOString() });
      });
    },
    async stop() {
      stopped = true;
      unsubscribe();
      clearInterval(poll);
      clearTimeout(startup);
      for (const { timer } of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.all(lanes.values());
    },
  };
}
