import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useHosts, type PluginScreenProps } from "@getpaseo/plugin/client";
import { decisionsDelete } from "../shared/rpc";
import { callHost, getHub, inboxOf, searchHostDecisions } from "./hub";

type SearchResult = Awaited<ReturnType<typeof searchHostDecisions>>;
type DecisionRow = SearchResult["decisions"][number];
type DeleteTarget = { decision: DecisionRow; all: boolean };

interface DecisionsProps {
  theme: PluginScreenProps["theme"];
  openSurface(target: { hostId: string; surfaceId: string }): void;
}

const PAGE_SIZE = 50;

function decisionKey({ hostId, surfaceId, questionId }: DecisionRow) {
  return JSON.stringify([hostId, surfaceId, questionId]);
}

export function Decisions({ theme, openSurface }: DecisionsProps) {
  const { colors } = theme;
  const hub = getHub();
  const snapshot = useSyncExternalStore(hub.subscribe, hub.getSnapshot);
  const hosts = useHosts();
  const { sources } = inboxOf(snapshot, hosts);
  const hostLabels = new Map(hosts.map((host) => [host.serverId, host.label]));
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState<(SearchResult & { query: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState(false);
  const inFlight = useRef(false);
  // Host summaries can be recreated by the SDK; use their routing IDs as the effect input.
  const readyIds = JSON.stringify(sources.filter((host) => host.docketStatus === "ready").map((host) => host.serverId).sort());

  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      const hostIds: string[] = JSON.parse(readyIds);
      void searchHostDecisions(hub, hostIds, { query, limit: limit + 1 }).then((result) => {
        if (!active) return;
        setSearch({ ...result, query });
        setLoading(false);
      });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [hub, snapshot, readyIds, query, limit, refresh]);

  const ready = (id: string) => sources.some((host) => host.serverId === id && host.docketStatus === "ready");
  const unavailable = sources.filter((host) => host.docketStatus !== "ready" || search?.unavailable.includes(host.serverId));
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

  function action(label: string, onPress: () => void, disabled = false, danger = false) {
    return (
      <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} style={styles.action}>
        <Text style={{ color: disabled ? colors.foregroundMuted : danger ? colors.statusDanger : colors.accent }}>{label}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.container}>
      <TextInput
        accessibilityLabel="Search decisions"
        placeholder="Search decisions"
        placeholderTextColor={colors.foregroundMuted}
        value={query}
        onChangeText={(value) => { setQuery(value); setLimit(PAGE_SIZE); }}
        style={[styles.search, foreground, { borderColor: colors.border, backgroundColor: colors.surface1 }]}
      />
      {!!unavailable.length && (
        <View style={styles.actions}>
          <Text style={muted}>Search unavailable on {unavailable.map((host) => host.label).join(", ")}.</Text>
          {action("Refresh", () => setRefresh((value) => value + 1), loading)}
        </View>
      )}
      {!!notice && <Text accessibilityLiveRegion="polite" style={foreground}>{notice}</Text>}
      {target && (
        <View style={[styles.card, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
          <Text style={foreground}>
            {target.all
              ? `Delete all decisions for agent ${target.decision.agentId} on ${hostName(target.decision.hostId)}? This includes decisions outside these search results. Some decisions may remain if deletion is refused.`
              : `Delete “${target.decision.label}” on ${hostName(target.decision.hostId)}?`}
          </Text>
          <Text style={muted}>This removes saved decisions from Docket history.</Text>
          <View style={styles.actions}>
            {action("Cancel", () => setTarget(null), deleting)}
            {action(deleting ? "Deleting…" : "Confirm deletion", () => { void remove(target); }, deleting, true)}
          </View>
        </View>
      )}
      <FlatList
        data={rows.slice(0, limit)}
        keyExtractor={decisionKey}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={muted}>{loading ? "Searching…" : unavailable.length ? "No matches from available hosts." : "No matching decisions."}</Text>}
        ListFooterComponent={rows.length > limit ? action("Show more", () => setLimit((value) => value + PAGE_SIZE), loading) : null}
        renderItem={({ item }) => {
          const { answer } = item;
          const values = answer?.text?.length ? answer.text : [answer?.value].flat().filter(Boolean);
          return (
            <View style={[styles.card, { backgroundColor: colors.surface1, borderColor: colors.border }]}>
              <Text style={[foreground, styles.title]}>{item.label}</Text>
              {item.prompt !== item.label && <Text selectable style={foreground}>{item.prompt}</Text>}
              <Text selectable style={muted}>{item.summary}</Text>
              {!!item.context && <Text selectable style={muted}>{item.context}</Text>}
              {!!values.length && <Text selectable style={foreground}>{values.join(", ")}</Text>}
              {!!answer?.other && <Text selectable style={foreground}>Custom answer · {answer.other}</Text>}
              {!!answer?.note && <Text selectable style={foreground}>Note · {answer.note}</Text>}
              {item.items?.map((review) => (
                <View key={review.id} style={[styles.reviewItem, { borderColor: colors.border }]}>
                  <Text style={[foreground, styles.title]}>{review.title}</Text>
                  {!!review.detail && <Text selectable style={muted}>{review.detail}</Text>}
                  <Text selectable style={foreground}>{review.answer.verdict}</Text>
                  {!!review.answer.comment && <Text selectable style={foreground}>{review.answer.comment}</Text>}
                </View>
              ))}
              <Text selectable style={muted}>{new Date(item.at).toLocaleString()} · {hostName(item.hostId)}</Text>
              <Text selectable style={muted}>Agent {item.agentId}{item.workspaceId ? ` · Workspace ${item.workspaceId}` : ""}</Text>
              {item.deliveryState !== "delivered" && <Text style={muted}>Delivery · {item.deliveryState ?? "unknown"}</Text>}
              <View style={styles.actions}>
                {action("Open surface", () => openSurface({ hostId: item.hostId, surfaceId: item.surfaceId }))}
                {action("Delete decision", () => setTarget({ decision: item, all: false }), !!target, true)}
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
  container: { flex: 1, gap: 10, padding: 12 },
  list: { gap: 10, paddingBottom: 12 },
  search: { minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderRadius: 8 },
  card: { gap: 6, padding: 12, borderWidth: 1, borderRadius: 8 },
  title: { fontWeight: "600" },
  reviewItem: { gap: 4, borderLeftWidth: 2, paddingLeft: 10 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  action: { minHeight: 44, justifyContent: "center", paddingHorizontal: 6 },
});
