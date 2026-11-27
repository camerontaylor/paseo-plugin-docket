import { expect, it } from "vitest";
import type { PluginHostSummary } from "@getpaseo/plugin/client";
import type { Summary } from "../shared/projections";
import { createHub, inboxOf } from "./hub";
import { cardStatus, countLabel, entityKey, groupInbox } from "./inbox-query";

const open: Summary = {
  id: "s_aaaaaa", rev: 1, agentId: "agent", workspaceId: "workspace", summary: "Question",
  status: "open", createdAt: "2026-11-22T00:00:00Z", resolvedAt: null, openQuestions: 2,
  pendingDeliveries: 0, replacedBy: null, revises: null, compacted: false,
};
const host = (serverId: string, status: PluginHostSummary["status"] = "online"): PluginHostSummary =>
  ({ serverId, label: serverId, status });

it("groups waiting cards and delivery failures, preserving oldest first within each group", () => {
  const groups = groupInbox([
    { hostId: "a", summary: { ...open, id: "s_bbbbbb", createdAt: "2026-11-22T00:01:00Z" } },
    { hostId: "b", summary: open, staleSince: 123 },
    { hostId: "a", summary: { ...open, meanwhile: "other_work" } },
    { hostId: "b", summary: { ...open, status: "resolved", pendingDeliveries: 1 } },
    { hostId: "a", summary: { ...open, status: "resolved" } },
  ]);
  expect([...groups.keys()]).toEqual(["Agent stopped", "Agent on other work", "Not delivered"]);
  expect(groups.get("Agent stopped")?.map(({ hostId, summary }) => entityKey(hostId, summary.id)))
    .toEqual([entityKey("b", open.id), entityKey("a", "s_bbbbbb")]);
  expect(groups.get("Agent on other work")).toHaveLength(1);
  expect(groups.get("Not delivered")).toHaveLength(1);
});

it("shares one source projection between global and host-qualified workspace counts", () => {
  const hub = createHub();
  const source = { rpc: async () => { throw new Error("Unexpected RPC"); } };
  hub.update(source, { hostId: "a", kind: "snapshot", summaries: [open, {
    ...open, id: "s_bbbbbb", workspaceId: "another-workspace",
  }] }, 123);
  hub.update(source, { hostId: "b", kind: "snapshot", summaries: [open] }, 456);
  const hosts = [host("a"), host("b", "offline"), host("never-seen")];
  const snapshot = hub.getSnapshot();
  const global = inboxOf(snapshot, hosts);
  expect(countLabel(global.count)).toBe("2+");
  expect(global.sources[2].docketStatus).toBe("pending");
  const workspace = (hostId: string) => inboxOf(snapshot, hosts, undefined, {
    hostId, workspaceId: "workspace",
  });
  expect(workspace("a").cards).toHaveLength(1);
  expect(countLabel(workspace("a").count)).toBe("1");
  expect(workspace("b").cards[0].staleSince).toBe(456);
  expect(countLabel(workspace("b").count)).toBe("Unknown");
  expect(countLabel(workspace("never-seen").count)).toBe("Unknown");
});

it("leads with outstanding delivery state only", () => {
  const removed = { n: 1, state: "removed" as const };
  // An older host may still list a delivery the user deleted; with nothing pending it is history.
  expect(cardStatus({ ...open, deliveries: [removed] }).label).toBe("Agent waiting · 2 questions");
  expect(cardStatus({ ...open, meanwhile: "other_work", deliveries: [removed] }).label).toBe("2 questions");
  expect(cardStatus({ ...open, pendingDeliveries: 1, deliveries: [{ n: 1, state: "queued" }] }).label).toBe("Sending");
  expect(cardStatus({ ...open, pendingDeliveries: 1, deliveries: [{ n: 1, state: "delivered" }, { n: 2, state: "failed" }] }).label)
    .toBe("Not delivered");
  expect(cardStatus({ ...open, pendingDeliveries: 1, deliveries: [{ n: 1, state: "uncertain" }] }).label).toBe("Checking delivery");
});
