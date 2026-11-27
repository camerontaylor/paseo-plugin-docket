import type { PluginAgentPanelProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useState, useSyncExternalStore } from "react";
import { Keyboard, ScrollView, Text, View } from "react-native";
import type { Summary } from "../shared/projections";
import { AGENT_PANEL_ICON, AGENT_PANEL_ID, agentSurfaces, registerComposerPills } from "./agent-panel-model";
import { getHub } from "./hub";
import { Button, EmptyState, Notice, NoticeText, Pill, SectionLabel, paneVisibility, radius, row, space, type } from "./kit";
import { SurfaceQuestions } from "./surface-questions";
import { useSurface } from "./use-surface";

type Theme = PluginAgentPanelProps["theme"];

/**
 * The answer controls for one surface. Once loaded they stay mounted while the
 * host is unavailable, hidden and inert, so unsaved edits and draft conflicts
 * held by the controls survive a reconnect.
 */
function SurfaceAnswers({ hostId, surfaceId, theme }: { hostId: string; surfaceId: string; theme: Theme }) {
  const { record, unavailable, refresh } = useSurface(hostId, surfaceId);
  const colors = theme.colors;
  const { display, ...visibility } = paneVisibility(!unavailable);
  return <View style={{ gap: space.md }}>
    {unavailable && <Notice colors={colors} tone="warning" icon="CloudOff"
      action={<Button colors={colors} compact icon="RotateCw" label="Refresh" onPress={() => void refresh()} />}>
      <NoticeText colors={colors}>Docket server unavailable</NoticeText>
    </Notice>}
    {!unavailable && !record && <Text style={{ ...type.body, color: colors.foregroundMuted }}>
      {record === null ? "This surface is no longer available." : "Loading questions…"}
    </Text>}
    {record && <View {...visibility} style={{ display, gap: space.md }}>
      <SurfaceQuestions key={JSON.stringify([hostId, surfaceId])} hostId={hostId} record={record} theme={theme} refresh={refresh} />
    </View>}
  </View>;
}

function SurfaceRow({ surface, hostId, theme, startOpen }: { surface: Summary; hostId: string; theme: Theme; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  // Keep the controls after the first expansion; collapsing only hides them.
  const [mounted, setMounted] = useState(startOpen);
  const colors = theme.colors;
  const waiting = surface.status === "open";
  const label = waiting ? surface.openQuestions === 1 ? "1 open question" : `${surface.openQuestions} open questions` : "Answered";
  const { display, ...visibility } = paneVisibility(open);
  return <View style={{ gap: space.md, padding: space.lg, borderRadius: radius.md, borderWidth: 1,
    borderColor: open && waiting ? colors.accent : colors.border, backgroundColor: colors.surface1 }}>
    <View style={[row, { justifyContent: "space-between" }]}>
      <Pill colors={colors} tone={waiting ? "accent" : "success"} icon={waiting ? "MessageCircleQuestion" : "CheckCircle2"} label={label} />
      {surface.pendingDeliveries > 0 && <Pill colors={colors} tone="warning" icon="Send" label="Delivery pending" />}
    </View>
    <Text style={{ ...type.title, color: colors.foreground }}>{surface.summary}</Text>
    {!open && !!surface.context && <Text numberOfLines={2} style={{ ...type.body, color: colors.foregroundMuted }}>{surface.context}</Text>}
    <View style={row}>
      <Button colors={colors} variant={open ? "secondary" : waiting ? "primary" : "secondary"} compact
        icon={open ? "ChevronUp" : waiting ? "PenLine" : "Eye"} label={open ? "Collapse" : waiting ? "Answer" : "View answers"}
        accessibilityLabel={`${open ? "Collapse" : waiting ? "Answer" : "View answers"}: ${surface.summary}`}
        onPress={() => {
          if (open) Keyboard.dismiss();
          else setMounted(true);
          setOpen(!open);
        }} />
    </View>
    {mounted && <View {...visibility} style={{ display, borderTopWidth: 1, borderColor: colors.border, paddingTop: space.md }}>
      <SurfaceAnswers hostId={hostId} surfaceId={surface.id} theme={theme} />
    </View>}
  </View>;
}

function AgentPanel({ host, params, theme }: PluginAgentPanelProps) {
  const { colors } = theme;
  const hub = getHub();
  const entry = useSyncExternalStore(hub.subscribe, () => hub.getSnapshot().get(host.id));
  const { open, resolved } = agentSurfaces(entry?.summaries.values() ?? [], params.agentId);
  return (
    <ScrollView style={{ backgroundColor: colors.surface0 }} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: space.lg, gap: space.md }}>
      {!entry?.fresh && <Notice colors={colors} tone={entry ? "warning" : "neutral"} icon={entry ? "CloudOff" : "Loader"}>
        <Text accessibilityRole="alert" style={{ ...type.body, color: colors.foreground }}>
          {entry ? "Showing last known questions" : "Waiting for questions…"}
        </Text>
      </Notice>}
      {entry?.fresh && !open.length && !resolved.length && <EmptyState colors={colors} icon="ClipboardCheck"
        title="No open questions" detail="Questions this agent asks with Docket appear here." />}
      {!!open.length && <SectionLabel colors={colors} title="Open" count={open.length} />}
      {open.map((surface, index) => <SurfaceRow key={surface.id} surface={surface} hostId={host.id} theme={theme} startOpen={index === 0} />)}
      {!!resolved.length && <SectionLabel colors={colors} title="Recently resolved" count={resolved.length} />}
      {resolved.map((surface) => <SurfaceRow key={surface.id} surface={surface} hostId={host.id} theme={theme} startOpen={false} />)}
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
