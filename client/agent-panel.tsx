import type { PluginAgentPanelProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Summary } from "../shared/projections";
import { AGENT_PANEL_ICON, AGENT_PANEL_ID, agentSurfaces, registerComposerPills } from "./agent-panel-model";
import { getHub } from "./hub";

function SurfaceSection({ title, surfaces, colors }: {
  title: string;
  surfaces: readonly Summary[];
  colors: PluginAgentPanelProps["theme"]["colors"];
}) {
  if (!surfaces.length) return null;
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={{ fontSize: 16, fontWeight: "600", color: colors.foreground }}>
        {title}
      </Text>
      {surfaces.map((surface) => (
        <View key={surface.id} style={{ gap: 4, padding: 12, borderRadius: 8, backgroundColor: colors.surface1 }}>
          <Text style={{ color: colors.foreground }}>{surface.summary}</Text>
          {surface.status === "open" && (
            <Text style={{ color: colors.foregroundMuted }}>
              {surface.openQuestions === 1 ? "1 open question" : `${surface.openQuestions} open questions`}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

function AgentPanel({ host, params, theme: { colors } }: PluginAgentPanelProps) {
  const hub = getHub();
  const entry = useSyncExternalStore(hub.subscribe, () => hub.getSnapshot().get(host.id));
  const { open, resolved } = agentSurfaces(entry?.summaries.values() ?? [], params.agentId);
  return (
    <ScrollView style={{ backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      {!entry?.fresh && (
        <Text accessibilityRole="alert" style={{ color: colors.foregroundMuted }}>
          {entry ? "Showing last known questions" : "Waiting for questions…"}
        </Text>
      )}
      {entry?.fresh && !open.length && !resolved.length && (
        <Text style={{ color: colors.foregroundMuted }}>No open or recently resolved questions</Text>
      )}
      <SurfaceSection title="Open" surfaces={open} colors={colors} />
      <SurfaceSection title="Recently resolved" surfaces={resolved} colors={colors} />
    </ScrollView>
  );
}

export function registerAgentPanel(client: PluginClientContext) {
  const removePanel = client.addAgentPanel({
    id: AGENT_PANEL_ID,
    title: "Docket",
    icon: AGENT_PANEL_ICON,
    Component: AgentPanel,
  });
  const removePills = registerComposerPills(client);
  return () => {
    removePills();
    return removePanel();
  };
}
