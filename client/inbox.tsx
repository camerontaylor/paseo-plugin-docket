import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Keyboard, ScrollView, Text, TextInput, View } from "react-native";
import { useAgent, useAgents, useWorkspace, useWorkspaces } from "@getpaseo/plugin/client";
import type { AgentRef, PluginClientContext, PluginHostProps, PluginScreenProps, PluginSidebarItemProps, WorkspaceRef } from "@getpaseo/plugin/client";
import * as ui from "@getpaseo/plugin/client/ui";
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type { SurfaceRecord } from "../shared/record";
import { InboxButton, buttonRow } from "./inbox-button";
import { countLabel, entityKey, groupInbox } from "./inbox-query";
import { useDocketInbox } from "./use-docket";

const screenId = "inbox";
const title = "Docket Inbox";
type Inbox = ReturnType<typeof useDocketInbox>;
type Theme = PluginHostProps["theme"];
type SurfaceTarget = { hostId: string; surfaceId: string };
type AnswerControls = {
  useSurface(hostId: string, surfaceId: string): {
    record: SurfaceRecord | null | undefined;
    unavailable: boolean;
    refresh(): Promise<SurfaceRecord | null | undefined>;
  };
  SurfaceQuestions: ComponentType<{
    hostId: string;
    theme: Theme;
    record: SurfaceRecord;
    refresh(): Promise<SurfaceRecord | null | undefined>;
  }>;
};

type InboxDependencies = AnswerControls & {
  Decisions: ComponentType<{ theme: Theme; openSurface(target: SurfaceTarget): void }>;
};

type HostState = Inbox["sources"][number]["docketStatus"];

const sourceLabels: Record<HostState, string> = {
  ready: "Up to date",
  pending: "Waiting for Docket snapshot",
  disconnected: "Disconnected",
  stale: "Docket updates unavailable",
  missing: "Docket plugin unavailable on this host",
};

function age(since: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function workspaceName(workspace: PluginWorkspaceSnapshot | null, fallback: string) {
  return workspace?.title || workspace?.name || fallback;
}

function WorkspaceFilter({ id, workspaceRef, active, choose, theme }: {
  id: string;
  workspaceRef?: WorkspaceRef;
  active: boolean;
  choose(): void;
  theme: Theme;
}) {
  const workspace = useWorkspace(workspaceRef ?? "");
  return <InboxButton label={workspaceName(workspace, id)} selected={active} theme={theme} onPress={choose} />;
}

function ExpandedCard({ hostId, surfaceId, theme, controls, ready, fromHistory = false }: {
  hostId: string;
  surfaceId: string;
  theme: Theme;
  controls: AnswerControls;
  ready: boolean;
  fromHistory?: boolean;
}) {
  const { record, unavailable, refresh } = controls.useSurface(hostId, surfaceId);
  const blocked = !ready || unavailable;
  return <View style={{ gap: 8 }}>
    {blocked && <View style={{ gap: 8 }}>
      <Text accessibilityRole="alert" style={{ color: theme.colors.statusWarning }}>The owning Docket host is unavailable.</Text>
      {ready && <InboxButton theme={theme} label="Reload surface" onPress={() => void refresh()} />}
    </View>}
    {!blocked && !record && <Text style={{ color: theme.colors.foregroundMuted }}>
      {record === null ? "This surface is no longer available." : "Loading questions…"}
    </Text>}
    {record && <View style={blocked ? { display: "none" } : { gap: 8 }}>
      {fromHistory && <>
        <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontWeight: "600" }}>{record.summary}</Text>
        {record.context && <Text style={{ color: theme.colors.foreground }}>{record.context}</Text>}
        {record.compactedAt !== null && <Text style={{ color: theme.colors.foregroundMuted }}>
          The original view was compacted. Saved answers are shown below.
        </Text>}
      </>}
      <controls.SurfaceQuestions key={entityKey(hostId, surfaceId)}
        hostId={hostId} theme={theme} record={record} refresh={refresh} />
    </View>}
  </View>;
}

function Card({ card, source, openChat, agentRef, workspaceRef, theme, now, controls }: {
  card: Inbox["cards"][number];
  source: Inbox["sources"][number] | undefined;
  openChat?(): void;
  agentRef?: AgentRef;
  workspaceRef?: WorkspaceRef;
  theme: Theme;
  now: number;
  controls: AnswerControls;
}) {
  const { summary } = card;
  const agent = useAgent(agentRef ?? "");
  const workspace = useWorkspace(workspaceRef ?? "");
  const [expanded, setExpanded] = useState(false);
  const ready = source?.docketStatus === "ready";
  const actionable = summary.status === "open" || summary.pendingDeliveries > 0;
  return <View style={{ padding: 12, gap: 8, borderColor: theme.colors.border, borderWidth: 1,
    borderRadius: 8, backgroundColor: theme.colors.surface1 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>{summary.summary}</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>
      {[agent?.title || summary.agentId, workspaceName(workspace, summary.workspaceId ?? "No workspace"),
        source?.label ?? card.hostId, `Asked ${age(Date.parse(summary.createdAt), now)}`].join(" · ")}
    </Text>
    {!ready && <Text style={{ color: theme.colors.statusWarning }}>
      {source ? sourceLabels[source.docketStatus] : "Docket updates unavailable"}
      {card.staleSince !== undefined ? ` · Last updated ${age(card.staleSince, now)}` : ""}
    </Text>}
    {summary.context && <Text style={{ color: theme.colors.foreground }}>{summary.context}</Text>}
    {!expanded && summary.questions?.filter((question) => question.state === "open").map((question) =>
      <Text key={question.id} style={{ color: theme.colors.foreground }}>
        {question.label}{question.recommend !== undefined ? " · Recommendation available" : ""}
      </Text>)}
    {summary.pendingDeliveries > 0 && <Text style={{ color: theme.colors.statusWarning }}>
      {summary.pendingDeliveries} awaiting delivery
    </Text>}
    <View style={buttonRow}>
      {(expanded || (ready && actionable)) && <InboxButton theme={theme}
        label={expanded ? "Hide details" : summary.status === "open" ? "Answer in place" : "Delivery details"}
        onPress={() => setExpanded(!expanded)} />}
      {openChat && <InboxButton theme={theme} label="Open chat" onPress={openChat}
        disabled={source?.docketStatus === "disconnected"} />}
    </View>
    {expanded && <ExpandedCard key={entityKey(card.hostId, summary.id)}
      hostId={card.hostId} surfaceId={summary.id} theme={theme} controls={controls} ready={ready} />}
  </View>;
}

function InboxQueue({ theme, navigation, controls, inbox }: PluginScreenProps & { controls: AnswerControls; inbox: Inbox }) {
  const [selectedHost, setHostFilter] = useState<string>();
  const [selectedWorkspace, setWorkspaceFilter] = useState<string>();
  const [label, setLabel] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const agentRefs = new Map(useAgents().map((ref) => [entityKey(ref.hostId, ref.id), ref]));
  const workspaceRefs = new Map(useWorkspaces().map((ref) => [entityKey(ref.hostId, ref.id), ref]));
  const needle = label.trim().toLowerCase();
  const matchingAgents = new Set(useAgents({
    where: (agent) => Object.entries(agent.labels).some(([key, value]) =>
      `${key} ${value}`.toLowerCase().includes(needle)),
  }).map((ref) => entityKey(ref.hostId, ref.id)));
  const sources = new Map(inbox.sources.map((host) => [host.serverId, host]));
  const removedHost = selectedHost !== undefined && !sources.has(selectedHost);
  const hostFilter = removedHost ? undefined : selectedHost;
  const workspaceFilter = removedHost ? undefined : selectedWorkspace;
  useEffect(() => {
    if (!removedHost) return;
    setHostFilter(undefined);
    setWorkspaceFilter(undefined);
  }, [removedHost]);
  const availableGroups = groupInbox(inbox.cards.filter((card) => !hostFilter || card.hostId === hostFilter));
  const workspaces = new Map([...availableGroups.values()].flat().flatMap(({ hostId, summary }) =>
    summary.workspaceId ? [[entityKey(hostId, summary.workspaceId), summary.workspaceId] as const] : []));
  const groups = groupInbox([...availableGroups.values()].flat().filter(({ hostId, summary }) =>
    (!workspaceFilter || (summary.workspaceId && entityKey(hostId, summary.workspaceId) === workspaceFilter))
    && (!needle || matchingAgents.has(entityKey(hostId, summary.agentId)))));
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: 16, gap: 14 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 18, fontWeight: "600" }}>Open · {countLabel(inbox.count)}</Text>
    {inbox.sources.filter((source) => source.docketStatus !== "ready").map((source) =>
      <Text key={source.serverId} style={{ color: theme.colors.statusWarning }}>
        {source.label} · {sourceLabels[source.docketStatus]}
        {source.updatedAt !== undefined ? ` · Last updated ${age(source.updatedAt, now)}` : ""}
      </Text>)}
    {inbox.sources.length > 1 && <View accessibilityLabel="Filter by host" style={buttonRow}>
      <InboxButton label="All hosts" selected={!hostFilter} theme={theme}
        onPress={() => { setHostFilter(undefined); setWorkspaceFilter(undefined); }} />
      {inbox.sources.map(({ serverId, label }) => <InboxButton key={serverId} label={label}
        selected={serverId === hostFilter} theme={theme}
        onPress={() => { setHostFilter(serverId); setWorkspaceFilter(undefined); }} />)}
    </View>}
    {(workspaces.size > 0 || workspaceFilter) && <View accessibilityLabel="Filter by workspace" style={buttonRow}>
      <InboxButton label="All workspaces" theme={theme} selected={!workspaceFilter} onPress={() => setWorkspaceFilter(undefined)} />
      {[...workspaces].map(([key, id]) => <WorkspaceFilter key={key} id={id} workspaceRef={workspaceRefs.get(key)}
        active={key === workspaceFilter} choose={() => setWorkspaceFilter(key)} theme={theme} />)}
    </View>}
    <TextInput accessibilityLabel="Filter by agent label" placeholder="Filter by agent label"
      placeholderTextColor={theme.colors.foregroundMuted} value={label} onChangeText={setLabel}
      style={{ color: theme.colors.foreground, padding: 8, borderWidth: 1, borderColor: theme.colors.border }} />
    {/* Keep each card under the same parent when its delivery changes sections. */}
    <View style={{ gap: 8 }}>
      {[...groups].flatMap(([section, cards]) => cards.length ? [
        <Text key={section} accessibilityRole="header"
          style={{ color: theme.colors.foreground, fontWeight: "600" }}>{section}</Text>,
        ...cards.map((card) => {
          const { hostId, summary } = card;
          return <Card key={entityKey(hostId, summary.id)} card={card} source={sources.get(hostId)} now={now}
            agentRef={agentRefs.get(entityKey(hostId, summary.agentId))}
            workspaceRef={summary.workspaceId ? workspaceRefs.get(entityKey(hostId, summary.workspaceId)) : undefined}
            theme={theme} controls={controls} openChat={navigation && (() => navigation.openAgent({ serverId: hostId, agentId: summary.agentId }))} />;
        }),
      ] : [])}
    </View>
    {[...groups.values()].every((cards) => cards.length === 0) && <Text style={{ color: theme.colors.foregroundMuted }}>
      {hostFilter || workspaceFilter || needle ? "No cards match these filters."
        : inbox.count.kind === "exact" ? "Nothing waiting in Docket." : "No cards available yet."}
    </Text>}
  </ScrollView>;
}

function InboxPane({ active, children }: { active: boolean; children: ReactNode }) {
  return <View role="tabpanel" style={{ flex: 1, display: active ? "flex" : "none" }}
    accessibilityElementsHidden={!active} importantForAccessibility={active ? "auto" : "no-hide-descendants"}
    pointerEvents={active ? "auto" : "none"}>
    {children}
  </View>;
}

function DocketInbox({ controls, ...props }: PluginScreenProps & { controls: InboxDependencies }) {
  const { theme } = props;
  const inbox = useDocketInbox();
  const [tab, setTab] = useState<"inbox" | "decisions">("inbox");
  const [target, setTarget] = useState<SurfaceTarget>();
  function selectTab(next: typeof tab) {
    if (next === tab) return;
    Keyboard.dismiss();
    setTab(next);
  }
  return <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
    <View accessibilityRole="tablist" style={[buttonRow, { padding: 12 }]}>
      <InboxButton theme={theme} label="Inbox" role="tab" selected={tab === "inbox"} onPress={() => selectTab("inbox")} />
      <InboxButton theme={theme} label="Decisions" role="tab" selected={tab === "decisions"} onPress={() => selectTab("decisions")} />
    </View>
    <InboxPane active={tab === "inbox"}>
      <InboxQueue {...props} controls={controls} inbox={inbox} />
    </InboxPane>
    <InboxPane active={tab === "decisions"}>
      <View style={{ flex: 1, display: target ? "none" : "flex" }}>
        <controls.Decisions theme={theme} openSurface={setTarget} />
      </View>
      {target && <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <View style={buttonRow}>
          <InboxButton theme={theme} label="Back to Decisions" onPress={() => setTarget(undefined)} />
        </View>
        <ExpandedCard key={entityKey(target.hostId, target.surfaceId)}
          {...target} theme={theme} controls={controls} fromHistory
          ready={inbox.sources.some((source) => source.serverId === target.hostId && source.docketStatus === "ready")} />
      </ScrollView>}
    </InboxPane>
  </View>;
}

function SidebarInbox({ theme, openScreen, currentScreen }: PluginSidebarItemProps) {
  const { count } = useDocketInbox();
  return <ui.SidebarRow icon="Inbox" label={title} active={currentScreen?.screenId === screenId}
    onPress={() => openScreen({ screenId })}
    trailing={<Text style={{ color: theme.colors.foregroundMuted }}>{countLabel(count)}</Text>} />;
}

// The row contribution and its component arrived after the pinned client SDK.
type WorkspaceBadgeProps = PluginHostProps & { workspaceId: string };
type WorkspaceBadgeApi = {
  addWorkspaceRowBadgeItem?(item: { id: string; title: string; icon: string; Component: ComponentType<WorkspaceBadgeProps> }): () => void;
};
const WorkspaceRowBadge = (ui as typeof ui & {
  WorkspaceRowBadge?: ComponentType<{ icon: string; label: string; accessibilityLabel: string }>;
}).WorkspaceRowBadge;

function WorkspaceInboxBadge({ host, workspaceId }: WorkspaceBadgeProps) {
  const { count, cards } = useDocketInbox(undefined, { hostId: host.id, workspaceId });
  const knownOpen = cards.some(({ summary }) => summary.status === "open");
  if (!WorkspaceRowBadge || !knownOpen) return null;
  const label = countLabel(count);
  return <WorkspaceRowBadge icon="Inbox" label={label} accessibilityLabel={`Docket open · ${label}`} />;
}

export function registerInbox(client: PluginClientContext, controls: InboxDependencies) {
  const removeScreen = client.addScreen({
    id: screenId, title, Component: (props) => <DocketInbox {...props} controls={controls} />,
  });
  const removeSidebar = client.addSidebarHeaderItem({ id: screenId, title, Component: SidebarInbox });
  const removeBadge = (client as PluginClientContext & WorkspaceBadgeApi).addWorkspaceRowBadgeItem?.({
    id: screenId, title, icon: "Inbox", Component: WorkspaceInboxBadge,
  });
  return () => {
    removeBadge?.();
    removeSidebar();
    removeScreen();
  };
}
