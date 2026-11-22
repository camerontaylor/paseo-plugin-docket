import type { PluginClientContext } from "@getpaseo/plugin/client";
import { expect, it, vi } from "vitest";
import type { Summary } from "../shared/projections";
import { AGENT_PANEL_ID, agentSurfaces, registerComposerPills } from "./agent-panel-model";
import { createHub } from "./hub";

const open: Summary = {
  id: "s_aaaaaa", rev: 1, agentId: "agent", workspaceId: "workspace", summary: "Review",
  status: "open", createdAt: "2026-11-20T00:00:00Z", resolvedAt: null, openQuestions: 2,
  pendingDeliveries: 0, replacedBy: null, revises: null, compacted: false,
};
const newer = { ...open, id: "s_bbbbbb", createdAt: "2026-11-21T00:00:00Z" };
const resolved: Summary = { ...open, status: "resolved", resolvedAt: "2026-11-22T00:00:00Z", openQuestions: 0 };

it("lists this agent's open surfaces oldest first and recently resolved surfaces newest first", () => {
  const earlierResolution = { ...resolved, id: "s_cccccc", resolvedAt: "2026-11-21T00:00:00Z" };
  const latestResolution = { ...resolved, id: "s_dddddd" };
  const result = agentSurfaces([
    earlierResolution, newer, latestResolution, open,
    { ...open, id: "s_eeeeee", status: "orphaned" },
    { ...open, id: "s_ffffff", agentId: "other" },
  ], "agent");
  expect(result).toEqual({ open: [open, newer], resolved: [latestResolution, earlierResolution] });
});

it("registers pills for its own host and updates, opens and removes them as surfaces change", () => {
  const hub = createHub();
  const update = vi.fn();
  const remove = vi.fn();
  const addComposerPill = vi.fn((_input: Parameters<PluginClientContext["addComposerPill"]>[0]) => ({ update, remove }));
  const client = { rpc: vi.fn<PluginClientContext["rpc"]>(), addComposerPill, openPanel: vi.fn() };
  const cleanup = registerComposerPills(client, hub);
  hub.update({ rpc: vi.fn() }, { kind: "snapshot", hostId: "other", summaries: [open] });
  expect(addComposerPill).not.toHaveBeenCalled();

  hub.update(client, { kind: "snapshot", hostId: "own", summaries: [open, newer] });
  expect(addComposerPill).toHaveBeenCalledOnce();
  const pill = addComposerPill.mock.calls[0][0];
  expect(pill).toMatchObject({ workspaceId: "workspace", agentId: "agent", button: { title: "2 open" } });
  if (pill.button.behavior.kind !== "action") throw new Error("Expected a panel-opening action");
  pill.button.behavior.onPress();
  expect(client.openPanel).toHaveBeenCalledWith(AGENT_PANEL_ID, { workspaceId: "workspace", agentId: "agent" });

  hub.update(client, { kind: "change", hostId: "own", surfaceId: open.id, rev: 2, summary: resolved });
  expect(update).toHaveBeenCalledWith({ title: "1 open" });
  hub.update(client, { kind: "change", hostId: "own", surfaceId: newer.id, rev: 2, summary: null, removed: true });
  expect(remove).toHaveBeenCalledOnce();

  hub.update(client, { kind: "snapshot", hostId: "own", summaries: [open] });
  hub.unavailable("own", client);
  expect(remove).toHaveBeenCalledTimes(2);
  hub.update(client, { kind: "snapshot", hostId: "own", summaries: [open] });
  cleanup();
  expect(remove).toHaveBeenCalledTimes(3);
  hub.update(client, { kind: "snapshot", hostId: "own", summaries: [newer] });
  expect(addComposerPill).toHaveBeenCalledTimes(3);
});
