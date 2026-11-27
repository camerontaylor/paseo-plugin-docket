import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Keyboard, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useAgent, useAgents, useWorkspace, useWorkspaces } from "@getpaseo/plugin/client";
import type { AgentRef, PluginClientContext, PluginHostProps, PluginScreenProps, PluginSidebarItemProps, WorkspaceRef } from "@getpaseo/plugin/client";
import * as ui from "@getpaseo/plugin/client/ui";
import type { PluginWorkspaceSnapshot } from "@getpaseo/plugin";
import type { SurfaceRecord } from "../shared/record";
import { InboxButton, buttonRow } from "./inbox-button";
import { countLabel, entityKey, groupInbox, inboxSection, type inboxSections } from "./inbox-query";
import { Button, Chip, EmptyState, Glyph, Notice, NoticeText, Pill, SectionLabel, inputStyle, radius, row, space, toneColor, type, type Tone } from "./kit";
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

// Section keys stay stable for grouping; the words describe what the user should do.
const sectionLabels: Record<typeof inboxSections[number], string> = {
  "Agent stopped": "Waiting on you",
  "Agent on other work": "Answer when ready",
  "Not delivered": "Delivery",
};

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
  return <Chip colors={theme.colors} label={workspaceName(workspace, id)} selected={active} onPress={choose} />;
}

// Retain only surfaces opened in this view. The owning screen releases the
// controls on unmount, and each view supplies its own terminal removal signal.
function useRetainedSurfaces() {
  const [opened, setOpened] = useState(() => new Map<string, SurfaceTarget>());
  function retain(target: SurfaceTarget) {
    const key = entityKey(target.hostId, target.surfaceId);
    setOpened((prior) => prior.has(key) ? prior : new Map(prior).set(key, target));
  }
  const prune = useCallback((keep: (target: SurfaceTarget, key: string) => boolean) => {
    setOpened((prior) => {
      const remaining = [...prior].filter(([key, target]) => keep(target, key));
      return remaining.length === prior.size ? prior : new Map(remaining);
    });
  }, []);
  const forget = useCallback((hostId: string, surfaceId: string) => {
    const key = entityKey(hostId, surfaceId);
    prune((_, openedKey) => openedKey !== key);
  }, [prune]);
  return { opened, retain, prune, forget };
}

function ExpandedCard({ hostId, surfaceId, theme, controls, ready, fromHistory = false, onMissing }: {
  hostId: string;
  surfaceId: string;
  theme: Theme;
  controls: AnswerControls;
  ready: boolean;
  fromHistory?: boolean;
  onMissing?(hostId: string, surfaceId: string): void;
}) {
  const { record, unavailable, refresh } = controls.useSurface(hostId, surfaceId);
  const blocked = !ready || unavailable;
  useEffect(() => {
    if (!blocked && record === null) onMissing?.(hostId, surfaceId);
  }, [blocked, record, onMissing, hostId, surfaceId]);
  const { display, ...visibility } = paneVisibility(!blocked);
  const colors = theme.colors;
  return <View style={{ gap: space.md }}>
    {blocked && <Notice colors={colors} tone="warning" icon="CloudOff"
      action={ready ? <Button colors={colors} compact icon="RotateCw" label="Reload surface" onPress={() => void refresh()} /> : undefined}>
      <Text accessibilityRole="alert" style={{ ...type.body, color: colors.foreground }}>The owning Docket host is unavailable.</Text>
    </Notice>}
    {!blocked && !record && <Text style={{ ...type.body, color: colors.foregroundMuted }}>
      {record === null ? "This surface is no longer available." : "Loading questions…"}
    </Text>}
    {record && <View {...visibility} style={blocked ? { display } : { gap: space.md }}>
      {fromHistory && <>
        <Text accessibilityRole="header" style={{ fontSize: 18, lineHeight: 24, fontWeight: "600", color: colors.foreground }}>{record.summary}</Text>
        {record.compactedAt !== null && <Notice colors={colors} icon="Archive">
          <NoticeText colors={colors}>The original view was compacted. Saved answers are shown below.</NoticeText>
        </Notice>}
        {(record.compactedAt !== null || !record.document) && record.context
          && <Text selectable style={{ ...type.body, color: colors.foregroundMuted }}>{record.context}</Text>}
      </>}
      <controls.SurfaceQuestions key={entityKey(hostId, surfaceId)}
        hostId={hostId} theme={theme} record={record} refresh={refresh} />
    </View>}
  </View>;
}

function paneVisibility(visible: boolean) {
  return {
    display: visible ? "flex" as const : "none" as const,
    accessibilityElementsHidden: !visible,
    importantForAccessibility: visible ? "auto" as const : "no-hide-descendants" as const,
    pointerEvents: visible ? "auto" as const : "none" as const,
  };
}

type CardStatus = { label: string; tone: Tone; icon: string };

/** The one status a card leads with: delivery trouble first, then whether the agent is blocked. */
function cardStatus(summary: Inbox["cards"][number]["summary"]): CardStatus {
  const states = summary.deliveries?.map(({ state }) => state) ?? [];
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

function Card({ card, source, openChat, agentRef, workspaceRef, theme, now, controls, visible, opened, retain, showHost }: {
  card: Inbox["cards"][number];
  visible: boolean;
  opened: boolean;
  retain(): void;
  source: Inbox["sources"][number] | undefined;
  openChat?(): void;
  agentRef?: AgentRef;
  workspaceRef?: WorkspaceRef;
  theme: Theme;
  now: number;
  controls: AnswerControls;
  showHost?: boolean;
}) {
  const { summary } = card;
  const colors = theme.colors;
  const agent = useAgent(agentRef ?? "");
  const workspace = useWorkspace(workspaceRef ?? "");
  const [expanded, setExpanded] = useState(false);
  const ready = source?.docketStatus === "ready";
  const actionable = summary.status === "open" || summary.pendingDeliveries > 0;
  const status = cardStatus(summary);
  const { display, ...visibility } = paneVisibility(visible);
  const { display: detailsDisplay, ...detailsVisibility } = paneVisibility(expanded);
  const openQuestions = summary.questions?.filter((question) => question.state === "open") ?? [];
  const meta = [agent?.title || summary.agentId, workspaceName(workspace, summary.workspaceId ?? "No workspace"),
    ...(showHost ? [source?.label ?? card.hostId] : [])].join(" · ");
  const answerLabel = summary.status === "open" ? "Answer" : "Delivery details";
  return <View {...visibility} style={{ display, flexDirection: "row", overflow: "hidden", borderWidth: 1,
    borderColor: expanded ? toneColor(colors, status.tone) ?? colors.border : colors.border,
    borderRadius: radius.md, backgroundColor: colors.surface1 }}>
    <View style={{ width: 3, backgroundColor: toneColor(colors, status.tone) }} />
    <View style={{ flex: 1, minWidth: 0, padding: space.lg, gap: space.md }}>
      <View style={[row, { justifyContent: "space-between" }]}>
        <Pill colors={colors} tone={status.tone} icon={status.icon} label={status.label} />
        <Text style={{ ...type.meta, color: colors.foregroundMuted }}>{`Asked ${age(Date.parse(summary.createdAt), now)}`}</Text>
      </View>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.foreground }}>{summary.summary}</Text>
        <Text numberOfLines={1} style={{ ...type.meta, color: colors.foregroundMuted }}>{meta}</Text>
      </View>
      {!ready && <Notice colors={colors} tone="warning" icon="CloudOff">
        <NoticeText colors={colors}>
          {source ? sourceLabels[source.docketStatus] : "Docket updates unavailable"}
          {card.staleSince !== undefined ? ` · Last updated ${age(card.staleSince, now)}` : ""}
        </NoticeText>
      </Notice>}
      {!expanded && !!summary.context && <Text numberOfLines={2} style={{ ...type.body, color: colors.foreground }}>{summary.context}</Text>}
      {!expanded && openQuestions.length > 0 && <View style={{ gap: 6 }}>
        {openQuestions.slice(0, 4).map((question) => <View key={question.id} style={[row, { flexWrap: "nowrap", gap: space.sm }]}>
          <Glyph name="CircleDashed" color={colors.foregroundMuted} size={14} />
          <Text numberOfLines={1} style={{ ...type.body, flexShrink: 1, color: colors.foreground }}>{question.label}</Text>
          {question.recommend !== undefined && <View style={[row, { flexWrap: "nowrap", gap: 3 }]}>
            <Glyph name="Sparkles" color={colors.accent} size={12} />
            <Text style={{ ...type.meta, color: colors.accent }}>Recommendation</Text>
          </View>}
        </View>)}
        {openQuestions.length > 4 && <Text style={{ ...type.meta, color: colors.foregroundMuted }}>{`+${openQuestions.length - 4} more`}</Text>}
      </View>}
      <View style={row}>
        {(expanded || (ready && actionable)) && <Button colors={colors}
          variant={expanded ? "secondary" : summary.status === "open" ? "primary" : "secondary"}
          icon={expanded ? "ChevronUp" : summary.status === "open" ? "PenLine" : "Truck"}
          label={expanded ? "Collapse" : answerLabel}
          accessibilityLabel={expanded ? `Collapse ${summary.summary}` : `${answerLabel}: ${summary.summary}`}
          onPress={() => {
            if (expanded) Keyboard.dismiss();
            else retain();
            setExpanded(!expanded);
          }} />}
        {openChat && <Button colors={colors} variant="ghost" icon="MessageSquare" label="Open chat" onPress={openChat}
          disabled={source?.docketStatus === "disconnected"} />}
      </View>
      {opened && <View {...detailsVisibility} style={{ display: detailsDisplay, borderTopWidth: 1, borderColor: colors.border, paddingTop: space.lg }}>
        <ExpandedCard key={entityKey(card.hostId, summary.id)}
          hostId={card.hostId} surfaceId={summary.id} theme={theme} controls={controls} ready={ready} />
      </View>}
    </View>
  </View>;
}

function InboxQueue({ theme, navigation, controls, inbox }: PluginScreenProps & { controls: AnswerControls; inbox: Inbox }) {
  const [selectedHost, setHostFilter] = useState<string>();
  const [selectedWorkspace, setWorkspaceFilter] = useState<string>();
  const [label, setLabel] = useState("");
  const [now, setNow] = useState(Date.now);
  const { opened, retain, prune } = useRetainedSurfaces();
  const eligible = inbox.cards.filter(({ summary }) => inboxSection(summary) !== undefined);
  useEffect(() => {
    const eligibleKeys = new Set(inbox.cards.flatMap(({ hostId, summary }) =>
      inboxSection(summary) ? [entityKey(hostId, summary.id)] : []));
    prune((_, key) => eligibleKeys.has(key));
  }, [inbox.cards, prune]);

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
  const visibleKeys = new Set([...groups.values()].flat().map(({ hostId, summary }) => entityKey(hostId, summary.id)));
  function renderCard(card: Inbox["cards"][number], visible: boolean) {
    const { hostId, summary } = card;
    const key = entityKey(hostId, summary.id);
    return <Card key={key} card={card} source={sources.get(hostId)} now={now}
      visible={visible} opened={opened.has(key)} retain={() => retain({ hostId, surfaceId: summary.id })}
      agentRef={agentRefs.get(entityKey(hostId, summary.agentId))}
      workspaceRef={summary.workspaceId ? workspaceRefs.get(entityKey(hostId, summary.workspaceId)) : undefined}
      showHost={inbox.sources.length > 1} theme={theme} controls={controls} openChat={navigation && (() => navigation.openAgent({ serverId: hostId, agentId: summary.agentId }))} />;
  }
  // Keep opened cards in the same keyed list even when a filter hides them.
  const rows = [...groups].flatMap(([section, cards]) => cards.length ? [
    <SectionLabel key={section} colors={theme.colors} title={sectionLabels[section]} count={cards.length} />,
    ...cards.map((card) => renderCard(card, true)),
  ] : []);
  for (const card of eligible) {
    const key = entityKey(card.hostId, card.summary.id);
    if (opened.has(key) && !visibleKeys.has(key)) rows.push(renderCard(card, false));
  }
  const colors = theme.colors;
  const filtered = !!(hostFilter || workspaceFilter || needle);
  return <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ padding: space.lg, gap: space.md, width: "100%", maxWidth: 880, alignSelf: "center" }}>
    {inbox.sources.filter((source) => source.docketStatus !== "ready").map((source) =>
      <Notice key={source.serverId} colors={colors} tone={source.docketStatus === "pending" ? "neutral" : "warning"}
        icon={source.docketStatus === "pending" ? "Loader" : "CloudOff"}>
        <NoticeText colors={colors} strong>{source.label}</NoticeText>
        <Text style={{ ...type.meta, color: colors.foregroundMuted }}>
          {sourceLabels[source.docketStatus]}
          {source.updatedAt !== undefined ? ` · Last updated ${age(source.updatedAt, now)}` : ""}
        </Text>
      </Notice>)}
    <FilterField theme={theme} value={label} onChange={setLabel} />
    {inbox.sources.length > 1 && <View accessibilityLabel="Filter by host" style={row}>
      <Chip colors={colors} label="All hosts" selected={!hostFilter}
        onPress={() => { setHostFilter(undefined); setWorkspaceFilter(undefined); }} />
      {inbox.sources.map(({ serverId, label }) => <Chip key={serverId} colors={colors} label={label}
        selected={serverId === hostFilter}
        onPress={() => { setHostFilter(serverId); setWorkspaceFilter(undefined); }} />)}
    </View>}
    {(workspaces.size > 1 || workspaceFilter) && <View accessibilityLabel="Filter by workspace" style={row}>
      <Chip colors={colors} label="All workspaces" selected={!workspaceFilter} onPress={() => setWorkspaceFilter(undefined)} />
      {[...workspaces].map(([key, id]) => <WorkspaceFilter key={key} id={id} workspaceRef={workspaceRefs.get(key)}
        active={key === workspaceFilter} choose={() => setWorkspaceFilter(key)} theme={theme} />)}
    </View>}
    <View style={{ gap: space.md }}>{rows}</View>
    {[...groups.values()].every((cards) => cards.length === 0) && (filtered
      ? <View style={{ alignItems: "center", gap: space.sm }}>
        <EmptyState colors={colors} icon="SearchX" title="No cards match these filters" />
        <Button colors={colors} label="Clear filters" onPress={() => { setLabel(""); setHostFilter(undefined); setWorkspaceFilter(undefined); }} />
      </View>
      : inbox.count.kind === "exact"
        ? <EmptyState colors={colors} icon="Inbox" title="Nothing waiting in Docket"
          detail="When an agent asks you something, it waits here until you answer." />
        : <EmptyState colors={colors} icon="Loader" title="No cards available yet" detail="Waiting for hosts to report their questions." />)}
  </ScrollView>;
}

function FilterField({ theme, value, onChange }: { theme: Theme; value: string; onChange(value: string): void }) {
  const [focused, setFocused] = useState(false);
  const colors = theme.colors;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, ...inputStyle(colors, focused),
    paddingVertical: 0, backgroundColor: colors.surface1 }}>
    <Glyph name="Search" color={colors.foregroundMuted} />
    <TextInput accessibilityLabel="Filter by agent label" placeholder="Filter by agent label"
      placeholderTextColor={colors.foregroundMuted} value={value} onChangeText={onChange}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={{ ...type.body, flex: 1, minHeight: 38, color: colors.foreground, outlineStyle: undefined, borderWidth: 0 }} />
    {!!value && <Pressable accessibilityRole="button" accessibilityLabel="Clear filter" onPress={() => onChange("")}
      style={{ padding: 4 }}><Glyph name="X" color={colors.foregroundMuted} size={14} /></Pressable>}
  </View>;
}

function InboxPane({ active, children }: { active: boolean; children: ReactNode }) {
  const { display, ...visibility } = paneVisibility(active);
  return <View role="tabpanel" {...visibility} style={{ flex: 1, display }}>
    {children}
  </View>;
}

function DocketInbox({ controls, ...props }: PluginScreenProps & { controls: InboxDependencies }) {
  const { theme } = props;
  const inbox = useDocketInbox();
  const [tab, setTab] = useState<"inbox" | "decisions">("inbox");
  const [target, setTarget] = useState<SurfaceTarget>();
  const { opened, retain, prune, forget } = useRetainedSurfaces();
  useEffect(() => {
    const hosts = new Set(inbox.sources.map(({ serverId }) => serverId));
    prune(({ hostId }) => hosts.has(hostId));
  }, [inbox.sources, prune]);

  const selectedKey = target && entityKey(target.hostId, target.surfaceId);
  const history = new Map(opened);
  // Keep the selected missing surface visible until the user goes back.
  if (selectedKey && target) history.set(selectedKey, target);
  const { display: listDisplay, ...listVisibility } = paneVisibility(!target);
  function openSurface(next: SurfaceTarget) {
    Keyboard.dismiss();
    retain(next);
    setTarget(next);
  }
  function closeSurface() {
    Keyboard.dismiss();
    setTarget(undefined);
  }
  function selectTab(next: typeof tab) {
    if (next === tab) return;
    Keyboard.dismiss();
    setTab(next);
  }
  return <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
    <View style={{ borderBottomWidth: 1, borderColor: theme.colors.border, paddingVertical: space.sm }}>
      <View style={{ width: "100%", maxWidth: 880, alignSelf: "center", paddingHorizontal: space.lg }}>
      <View accessibilityRole="tablist" style={{ flexDirection: "row", alignSelf: "flex-start", gap: 2, padding: 3,
        borderRadius: radius.sm + 2, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border }}>
        <InboxButton theme={theme} label="Inbox" role="tab" selected={tab === "inbox"} onPress={() => selectTab("inbox")} />
        <InboxButton theme={theme} label="Decisions" role="tab" selected={tab === "decisions"} onPress={() => selectTab("decisions")} />
      </View>
      </View>
    </View>
    <InboxPane active={tab === "inbox"}>
      <InboxQueue {...props} controls={controls} inbox={inbox} />
    </InboxPane>
    <InboxPane active={tab === "decisions"}>
      <View {...listVisibility} style={{ flex: 1, display: listDisplay }}>
        <controls.Decisions theme={theme} openSurface={openSurface} />
      </View>
      {[...history].map(([key, entry]) => {
        const { display, ...visibility } = paneVisibility(selectedKey === key);
        const ready = inbox.sources.some((source) => source.serverId === entry.hostId && source.docketStatus === "ready");
        return <ScrollView key={key} {...visibility} style={{ flex: 1, display }}
          contentContainerStyle={{ padding: space.lg, gap: space.lg, width: "100%", maxWidth: 880, alignSelf: "center" }}>
          <View style={buttonRow}>
            <InboxButton theme={theme} variant="ghost" icon="ArrowLeft" label="Back to Decisions" onPress={closeSurface} />
          </View>
          <ExpandedCard {...entry} theme={theme} controls={controls} fromHistory ready={ready} onMissing={forget} />
        </ScrollView>;
      })}
    </InboxPane>
  </View>;
}

function SidebarInbox({ theme, openScreen, currentScreen }: PluginSidebarItemProps) {
  const { count } = useDocketInbox();
  return <ui.SidebarRow icon="Inbox" label={title} active={currentScreen?.screenId === screenId}
    onPress={() => openScreen({ screenId })}
    trailing={count.kind === "exact" && count.value === 0 ? undefined
      : <Text style={{ ...type.meta, fontWeight: "600", color: theme.colors.foregroundMuted }}>{countLabel(count)}</Text>} />;
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
