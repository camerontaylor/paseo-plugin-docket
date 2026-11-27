import type { Summary } from "../shared/projections";
import type { inboxOf } from "./hub";
import type { Tone } from "./kit";

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

export type CardStatus = { label: string; tone: Tone; icon: string };

/** The one status a card leads with: delivery trouble first, then whether the agent is blocked. */
export function cardStatus(summary: Summary): CardStatus {
  // Only outstanding deliveries count. Hosts before this change also list deliveries the
  // user deleted, so with nothing pending the listed states are history, not status.
  const states = summary.pendingDeliveries > 0
    ? summary.deliveries?.map(({ state }) => state).filter((state) => state !== "delivered") ?? [] : [];
  if (states.some((state) => state === "failed" || state === "held" || state === "removed")) {
    return { label: "Not delivered", tone: "danger", icon: "AlertTriangle" };
  }
  if (states.includes("uncertain")) return { label: "Checking delivery", tone: "warning", icon: "Loader" };
  if (summary.pendingDeliveries > 0) return { label: "Sending", tone: "accent", icon: "Send" };
  const questions = summary.openQuestions === 1 ? "1 question" : `${summary.openQuestions} questions`;
  return summary.meanwhile === "other_work"
    ? { label: questions, tone: "accent", icon: "MessageCircleQuestion" }
    : { label: `Agent waiting · ${questions}`, tone: "warning", icon: "Hourglass" };
}
