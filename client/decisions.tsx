import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FlatList, StyleSheet, Text, TextInput, View } from "react-native";
import { useHosts, type PluginScreenProps } from "@getpaseo/plugin/client";
import { decisionsDelete } from "../shared/rpc";
import { watchDecisionSearch } from "./decision-search";
import { callHost, getHub, inboxOf, searchHostDecisions } from "./hub";
import { Button, EmptyState, Glyph, Notice, NoticeText, Pill, inputStyle, radius, row, space, type } from "./kit";

type SearchResult = Awaited<ReturnType<typeof searchHostDecisions>>;
type DecisionRow = SearchResult["decisions"][number];
type DeleteTarget = { decision: DecisionRow; all: boolean };

interface DecisionsProps {
  theme: PluginScreenProps["theme"];
  /** Fetch the surface on hostId. Show an expired-view notice if its document is
   * compacted, or an unavailable notice if the record cannot be loaded. */
  openSurface(target: { hostId: string; surfaceId: string }): void;
  /** Hosts affirmatively known to lack Docket. */
  confirmedMissing?: ReadonlySet<string>;
}

const PAGE_SIZE = 50;

function decisionKey({ hostId, surfaceId, questionId }: DecisionRow) {
  return JSON.stringify([hostId, surfaceId, questionId]);
}

export function Decisions({ theme, openSurface, confirmedMissing }: DecisionsProps) {
  const { colors } = theme;
  const hub = getHub();
  const snapshot = useSyncExternalStore(hub.subscribe, hub.getSnapshot);
  const hosts = useHosts();
  const { sources } = inboxOf(snapshot, hosts, confirmedMissing);
  const hostLabels = new Map(hosts.map((host) => [host.serverId, host.label]));
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState<(SearchResult & { query: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [focused, setFocused] = useState(false);
  const inFlight = useRef(false);
  // Host summaries can be recreated by the SDK; use their routing IDs as the effect input.
  const readyIds = JSON.stringify(sources.filter((host) => host.docketStatus === "ready").map((host) => host.serverId).sort());

  useEffect(() => {
    setLoading(true);
    const hostIds: string[] = JSON.parse(readyIds);
    return watchDecisionSearch(
      hub.subscribe,
      () => searchHostDecisions(hub, hostIds, { query, limit: limit + 1 }),
      (result) => {
        setSearch({ ...result, query });
        setLoading(false);
      },
    );
  }, [hub, readyIds, query, limit, refresh]);

  const ready = (id: string) => sources.some((host) => host.serverId === id && host.docketStatus === "ready");
  const unavailable = sources.filter((host) => host.docketStatus !== "missing" && (host.docketStatus !== "ready" || search?.unavailable.includes(host.serverId)));
  const rows = search?.query === query ? search.decisions.filter((row) => ready(row.hostId)) : [];
  const hostName = (id: string) => hostLabels.get(id) ?? id;
  const foreground = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted };

  async function remove({ decision, all }: DeleteTarget) {
    const { hostId, agentId, surfaceId, questionId } = decision;
    if (inFlight.current) return;
    if (!ready(hostId) || !hub.getSnapshot().get(hostId)?.fresh) {
      setNotice("This host is unavailable. Try again when it reconnects.");
      setTarget(null);
      return;
    }
    inFlight.current = true;
    setDeleting(true);
    setNotice("");
    try {
      const result = await callHost(hub, hostId, decisionsDelete, all ? { agentId } : { surfaceId, questionId });
      if ("refusal" in result) {
        setNotice(all ? `${result.refusal.message} Other decisions may have been deleted.` : result.refusal.message);
      } else {
        setNotice(all ? "Agent decisions deleted." : "Decision deleted.");
      }
    } catch {
      setNotice(all
        ? "The host did not confirm deletion. Some decisions may have been deleted."
        : "The host did not confirm deletion. The decision may have been deleted.");
    } finally {
      inFlight.current = false;
      setDeleting(false);
      setTarget(null);
      setSearch(null);
      setRefresh((value) => value + 1);
    }
  }

  function action(label: string, onPress: () => void, disabled = false, danger = false, icon?: string, variant?: "primary" | "secondary") {
    return <Button colors={colors} compact label={label} onPress={onPress} disabled={disabled} icon={icon}
      variant={variant ?? (danger ? "danger" : "ghost")} />;
  }

  return (
    <View style={styles.container}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, ...inputStyle(colors, focused),
        paddingVertical: 0, backgroundColor: colors.surface1 }}>
        <Glyph name="Search" color={colors.foregroundMuted} />
        <TextInput
          accessibilityLabel="Search decisions"
          placeholder="Search decisions"
          placeholderTextColor={colors.foregroundMuted}
          value={query}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChangeText={(value) => { setQuery(value); setLimit(PAGE_SIZE); }}
          style={[styles.search, foreground]}
        />
      </View>
      {!!unavailable.length && (
        <Notice colors={colors} tone="warning" icon="CloudOff" action={action("Refresh", () => setRefresh((value) => value + 1), loading, false, "RotateCw", "secondary")}>
          <NoticeText colors={colors}>Search unavailable on {unavailable.map((host) => host.label).join(", ")}.</NoticeText>
        </Notice>
      )}
      {!!notice && <Notice colors={colors} icon="Info"><Text accessibilityLiveRegion="polite" style={[type.body, foreground]}>{notice}</Text></Notice>}
      {target && (
        <Notice colors={colors} tone="danger" icon="Trash2" action={<View style={row}>
          {action("Cancel", () => setTarget(null), deleting, false, undefined, "secondary")}
          {action(deleting ? "Deleting…" : "Confirm deletion", () => { void remove(target); }, deleting, true)}
        </View>}>
          <NoticeText colors={colors} strong>
            {target.all
              ? `Delete all decisions for agent ${target.decision.agentId} on ${hostName(target.decision.hostId)}? This includes decisions outside these search results. Some decisions may remain if deletion is refused.`
              : `Delete “${target.decision.label}” on ${hostName(target.decision.hostId)}?`}
          </NoticeText>
          <Text style={[type.meta, muted]}>This removes saved decisions from Docket history.</Text>
        </Notice>
      )}
      <FlatList
        data={rows.slice(0, limit)}
        keyExtractor={decisionKey}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListEmptyComponent={loading ? <EmptyState colors={colors} icon="Loader" title="Searching…" />
          : <EmptyState colors={colors} icon="History" title={query ? "No matching decisions" : "No decisions yet"}
            detail={unavailable.length ? "Only available hosts were searched." : query ? undefined : "Answers you send are kept here so you can find them later."} />}
        ListFooterComponent={rows.length > limit ? <View style={{ alignItems: "center" }}>
          {action("Show more", () => setLimit((value) => value + PAGE_SIZE), loading, false, "ChevronDown", "secondary")}
        </View> : null}
        renderItem={({ item }) => {
          const { answer } = item;
          const values = answer?.text?.length ? answer.text : [answer?.value].flat().filter(Boolean);
          const delivered = item.deliveryState === "delivered";
          return (
            <View style={[styles.card, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
              <View style={[row, { justifyContent: "space-between", flexWrap: "nowrap", alignItems: "flex-start" }]}>
                <Text style={[type.title, foreground, { flex: 1, minWidth: 0 }]}>{item.label}</Text>
                <Pill colors={colors} tone={delivered ? "success" : item.deliveryState === "failed" || item.deliveryState === "removed" ? "danger" : "warning"}
                  icon={delivered ? "CheckCheck" : "Send"}
                  label={delivered ? "Delivered" : `Delivery · ${item.deliveryState ?? "unknown"}`} />
              </View>
              {item.prompt !== item.label && <Text selectable style={[type.body, foreground]}>{item.prompt}</Text>}
              {(!!values.length || !!answer?.other || !!answer?.note) && <View style={[styles.answer, { backgroundColor: colors.surface2, borderColor: colors.accent }]}>
                {!!values.length && <Text selectable style={[type.body, foreground, { fontWeight: "600" }]}>{values.join(", ")}</Text>}
                {!!answer?.other && <Text selectable style={[type.body, foreground]}>Custom answer · {answer.other}</Text>}
                {!!answer?.note && <Text selectable style={[type.body, foreground]}>Note · {answer.note}</Text>}
              </View>}
              {item.items?.map((review) => (
                <View key={review.id} style={[styles.reviewItem, { borderColor: colors.border }]}>
                  <View style={[row, { flexWrap: "nowrap" }]}>
                    <Text style={[type.body, foreground, { fontWeight: "600", flexShrink: 1 }]}>{review.title}</Text>
                    {!!review.answer.verdict && <Pill colors={colors} tone="accent" label={review.answer.verdict} />}
                  </View>
                  {!!review.detail && <Text selectable style={[type.meta, muted]}>{review.detail}</Text>}
                  {!!review.answer.comment && <Text selectable style={[type.body, foreground]}>{review.answer.comment}</Text>}
                </View>
              ))}
              <Text selectable numberOfLines={2} style={[type.meta, muted]}>{item.summary}</Text>
              {!!item.context && <Text selectable numberOfLines={2} style={[type.meta, muted]}>{item.context}</Text>}
              <Text selectable style={[type.meta, muted]}>
                {[new Date(item.at).toLocaleString(), hostName(item.hostId), `Agent ${item.agentId}`,
                  ...(item.workspaceId ? [`Workspace ${item.workspaceId}`] : [])].join(" · ")}
              </Text>
              <View style={styles.actions}>
                {action("Open surface", () => openSurface({ hostId: item.hostId, surfaceId: item.surfaceId }), false, false, "ArrowUpRight", "secondary")}
                {action("Delete decision", () => setTarget({ decision: item, all: false }), !!target, true, "Trash2")}
                {action("Delete all for agent", () => setTarget({ decision: item, all: true }), !!target, true)}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: space.md, padding: space.lg, width: "100%", maxWidth: 880, alignSelf: "center" },
  list: { gap: space.md, paddingBottom: space.lg },
  search: { flex: 1, minHeight: 40, fontSize: 14 },
  card: { gap: space.sm, padding: space.lg, borderWidth: 1, borderRadius: radius.md },
  answer: { gap: 2, paddingHorizontal: space.md, paddingVertical: space.sm, borderLeftWidth: 3, borderRadius: radius.sm },
  reviewItem: { gap: 4, borderLeftWidth: 2, paddingLeft: 10 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs, paddingTop: space.xs },
});
