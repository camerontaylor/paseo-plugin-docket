import type { Summary } from "../shared/projections";
import type { inboxOf } from "./hub";

export const inboxSections = ["Agent stopped", "Agent on other work", "Not delivered"] as const;
type InboxSection = typeof inboxSections[number];
type InboxCard = ReturnType<typeof inboxOf>["cards"][number];

export function inboxSection(summary: Summary): InboxSection | undefined {
  if (summary.pendingDeliveries > 0) return "Not delivered";
  if (summary.status === "open") {
    return summary.meanwhile === "other_work" ? "Agent on other work" : "Agent stopped";
  }
}

export function groupInbox(cards: readonly InboxCard[]) {
  const groups = new Map(inboxSections.map((section) => [section, [] as InboxCard[]]));
  for (const card of cards) {
    const section = inboxSection(card.summary);
    if (section) groups.get(section)?.push(card);
  }
  for (const cards of groups.values()) {
    cards.sort((a, b) => Date.parse(a.summary.createdAt) - Date.parse(b.summary.createdAt)
      || a.hostId.localeCompare(b.hostId) || a.summary.id.localeCompare(b.summary.id));
  }
  return groups;
}

export function countLabel(count: ReturnType<typeof inboxOf>["count"]) {
  if (count.kind === "unknown") return "Unknown";
  return count.kind === "lower-bound" ? `${count.value}+` : String(count.value);
}

export const entityKey = (hostId: string, id: string) => JSON.stringify([hostId, id]);
