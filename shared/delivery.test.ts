import { describe, expect, it } from "vitest";
import { deliveryAction, type AgentDeliveryState, type DeliveryTransport, type QueueItemState } from "./delivery";
import type { Delivery, DeliveryState } from "./record";

const delivery: Delivery = {
  n: 1, state: "queued", messageId: "docket:s_123456:1", text: "answer",
  attempts: 0, createdAt: "", targets: [], comments: [],
};

describe("delivery decision table", () => {
  const states: DeliveryState[] = ["queued", "held", "failed", "uncertain", "removed", "delivered"];
  const agents: AgentDeliveryState[] = ["ready", "busy", "archived", "missing"];
  const items: QueueItemState[] = ["absent", "pending", "dispatching", "uncertain", "failed"];
  const transports: DeliveryTransport[] = ["queue", "direct"];
  const flags = [false, true];

  it("covers all observations without sending into busy, archived or missing agents", () => {
    const actions = new Set();
    for (const state of states) for (const agent of agents) for (const item of items) {
      for (const transport of transports) for (const inTimeline of flags) for (const retryDue of flags) {
        for (const enqueued of flags) for (const sent of flags) for (const retry of flags) {
          const d = { ...delivery, state, transport, enqueued, sent, queueRetryRevision: retry ? 1 : undefined };
          const action = deliveryAction({ delivery: d, transport, agent, item, inTimeline, retryDue });
          expect(action).toBeDefined();
          actions.add(action);
          if (action === "send") expect([state, agent, transport, inTimeline, retryDue, sent])
            .toEqual(["queued", "ready", "direct", false, true, false]);
          if (action === "enqueue") expect([state, transport, item, inTimeline, retryDue, enqueued, retry])
            .toEqual(["queued", "queue", "absent", false, true, false, false]);
          if ((action === "deliver" || action === "deliverAndRemove") && state !== "delivered") expect(inTimeline).toBe(true);
        }
      }
    }
    expect([...actions].sort()).toEqual([
      "deliver", "deliverAndRemove", "enqueue", "failMissing", "failQueue", "hold",
      "remove", "removeHeld", "retryQueue", "send", "uncertain", "wait",
    ]);
  });
});
