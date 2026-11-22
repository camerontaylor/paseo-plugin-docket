import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { Summary } from "../shared/projections";
import { getHub, type Hub } from "./hub";

export const AGENT_PANEL_ID = "docket-questions";
export const AGENT_PANEL_ICON = "ClipboardList";

export function agentSurfaces(summaries: Iterable<Summary>, agentId: string) {
  const open: Summary[] = [];
  const resolved: Summary[] = [];
  for (const surface of summaries) {
    if (surface.agentId !== agentId) continue;
    if (surface.status === "open") open.push(surface);
    if (surface.status === "resolved") resolved.push(surface);
  }
  open.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  resolved.sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "") || a.id.localeCompare(b.id));
  return { open, resolved };
}

type PillClient = Pick<PluginClientContext, "rpc" | "openPanel" | "addComposerPill">;
type Pill = ReturnType<PillClient["addComposerPill"]>;

export function registerComposerPills(client: PillClient, hub: Hub = getHub()) {
  const pills = new Map<string, { count: number; registration: Pill }>();

  function sync() {
    const targets = new Map<string, { workspaceId: string; agentId: string; count: number }>();
    for (const host of hub.getSnapshot().values()) {
      if (host.source !== client || !host.fresh) continue;
      for (const { workspaceId, agentId, status } of host.summaries.values()) {
        if (!workspaceId || status !== "open") continue;
        const key = JSON.stringify([workspaceId, agentId]);
        const target = targets.get(key);
        if (target) target.count++;
        else targets.set(key, { workspaceId, agentId, count: 1 });
      }
    }

    for (const [key, pill] of pills) {
      if (targets.has(key)) continue;
      pill.registration.remove();
      pills.delete(key);
    }
    for (const [key, { workspaceId, agentId, count }] of targets) {
      const title = `${count} open`;
      const pill = pills.get(key);
      if (pill) {
        if (pill.count !== count) {
          pill.registration.update({ title });
          pill.count = count;
        }
        continue;
      }
      const registration = client.addComposerPill({
        id: AGENT_PANEL_ID,
        workspaceId,
        agentId,
        button: {
          title,
          icon: AGENT_PANEL_ICON,
          behavior: { kind: "action", onPress: () => client.openPanel(AGENT_PANEL_ID, { workspaceId, agentId }) },
        },
      });
      pills.set(key, { count, registration });
    }
  }

  const unsubscribe = hub.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    for (const { registration } of pills.values()) registration.remove();
    pills.clear();
  };
}
