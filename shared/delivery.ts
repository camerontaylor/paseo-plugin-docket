import type { Delivery } from "./record";

export type DeliveryTransport = "direct" | "queue";
export type AgentDeliveryState = "missing" | "archived" | "busy" | "ready";
export type QueueItemState = "absent" | "pending" | "dispatching" | "uncertain" | "failed";

export type DeliveryAction = "wait" | "hold" | "removeHeld" | "deliver" | "deliverAndRemove"
  | "failMissing" | "failQueue" | "remove" | "uncertain" | "enqueue" | "retryQueue" | "send";

export interface DeliveryObservation {
  delivery: Delivery;
  transport: DeliveryTransport;
  agent: AgentDeliveryState;
  item: QueueItemState;
  inTimeline: boolean;
  retryDue: boolean;
  confirmationExpired?: boolean;
}

// First matching row wins. Busy includes a pending permission; queue admission
// is owned by the daemon. "Absent" means a successful queue read found no item.
export function deliveryAction({
  delivery: d, transport, agent, item, inTimeline, retryDue, confirmationExpired,
}: DeliveryObservation): DeliveryAction {
  const queue = transport === "queue";
  if (d.text === "") return "wait";
  if (d.state === "delivered") return queue && item === "uncertain" ? "deliverAndRemove" : "wait";
  const failedInQueue = d.state === "failed" && queue && d.enqueued && d.transport === "queue";
  const heldWithAttempt = d.state === "held" && (d.enqueued || d.transport);
  if (inTimeline && (d.state === "queued" || d.state === "uncertain" || heldWithAttempt || failedInQueue)) {
    return queue && item === "uncertain" ? "deliverAndRemove" : "deliver";
  }
  if (d.state === "held") return queue && (d.enqueued || item !== "absent" || (d.transport === "queue" && d.enqueued === undefined)) ? "removeHeld" : "wait";
  if (d.state === "removed") return "wait";
  if (d.state === "failed") {
    return failedInQueue && item === "absent" && agent !== "missing" && agent !== "archived" ? "remove" : "wait";
  }
  if (agent === "missing") return "failMissing";
  if (agent === "archived") return "hold";
  if (!queue) {
    if (d.state === "queued" && d.sent && confirmationExpired) return "uncertain";
    return d.state === "queued" && !d.sent && agent === "ready" && retryDue ? "send" : "wait";
  }
  if (item === "uncertain" || item === "failed") {
    if (d.queueRetryRevision !== undefined && d.state === "queued") return "retryQueue";
    return item === "uncertain" ? "uncertain" : "failQueue";
  }
  if (item !== "absent") return "wait";
  if (d.enqueued || d.queueRetryRevision !== undefined) return "remove";
  return d.state === "queued" && retryDue ? "enqueue" : "wait";
}
