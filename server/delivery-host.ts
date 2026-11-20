import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { DeliveryTransport, QueueItemState } from "../shared/delivery";

export type PaseoApi = PluginHandlerContext["paseo"];
export type DeliveryAgent = ReturnType<PaseoApi["agents"]["ref"]>;

export interface QueueSnapshot {
  revision: number;
  items: readonly {
    id: string;
    deliveryState: Exclude<QueueItemState, "absent">;
  }[];
}

// Structural subset of H1. The pinned stock SDK does not declare this fork API.
interface QueueHandle {
  list(): Promise<QueueSnapshot>;
  enqueue(options: { itemId: string; text: string; intent: "queue" }): Promise<QueueSnapshot>;
  remove(id: string, revision: number): Promise<QueueSnapshot>;
  retry(id: string, revision: number): Promise<QueueSnapshot>;
}

export function queueOf(agent: DeliveryAgent): QueueHandle | undefined {
  return (agent as DeliveryAgent & { queue?: QueueHandle }).queue;
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return (typeof error === "object" && error !== null && "code" in error && error.code === code)
    || (error instanceof Error && error.message === code);
}

export async function selectTransport(agent: DeliveryAgent): Promise<DeliveryTransport> {
  const queue = queueOf(agent);
  if (!queue) return "direct";
  try {
    await queue.list();
    return "queue";
  } catch (error) {
    if (hasErrorCode(error, "AGENT_QUEUE_UNSUPPORTED")) return "direct";
    throw error;
  }
}

export async function timelineText(agent: DeliveryAgent, id: string): Promise<string | undefined> {
  let page = await agent.timeline.refetch({ direction: "tail", projection: "canonical", limit: 200 });
  for (;;) {
    if (page.error) throw new Error(page.error);
    for (const { item } of page.entries) {
      if (item.type === "user_message" && (item.messageId === id || item.clientMessageId === id)) {
        return item.text;
      }
    }
    if (page.staleCursor || page.gap || (page.hasOlder && !page.startCursor)) {
      throw new Error("Agent timeline changed while checking delivery");
    }
    if (!page.hasOlder || !page.startCursor) return undefined;
    const cursor = page.startCursor;
    page = await agent.timeline.refetch({ direction: "before", cursor, projection: "canonical", limit: 200 });
    if (page.reset || page.epoch !== cursor.epoch || (page.hasOlder && page.startCursor && page.startCursor.seq >= cursor.seq)) {
      throw new Error("Agent timeline changed while checking delivery");
    }
  }
}
