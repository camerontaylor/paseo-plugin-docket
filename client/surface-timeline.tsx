import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import { isSurfaceId } from "../shared/ids";
import { SurfaceQuestions } from "./surface-questions";
import { SURFACE_KIND, surfaceTransformer } from "./surface-anchor";
import { useSurface } from "./use-surface";

const schema = z.object({ surfaceId: z.string().refine(isSurfaceId), fallback: z.string().optional() });
const styles = StyleSheet.create({
  card: { gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, minWidth: 0, flexShrink: 1 },
  title: { fontSize: 15, fontWeight: "600" },
});

function SurfaceCard({ host, item, theme, agentId }: PluginTimelineItemProps<z.output<typeof schema>>) {
  const { surfaceId, fallback } = item.data;
  const { record, unavailable, refresh } = useSurface(host.id, surfaceId);
  const colors = theme.colors;
  const visible = record?.agentId === agentId ? record : undefined;

  return <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface1 }]}>
    {(unavailable || !visible) && <>
      <Text style={{ color: colors.foregroundMuted }}>
        {unavailable ? "Docket server unavailable" : record === undefined ? "Loading questions…" : "Surface unavailable"}
      </Text>
      {!!fallback && <Text selectable style={{ color: colors.foreground }}>{fallback}</Text>}
      {unavailable && <Pressable accessibilityRole="button" onPress={() => void refresh()}>
        <Text style={{ color: colors.accent }}>Refresh questions</Text>
      </Pressable>}
    </>}
    {visible && <View style={unavailable ? { display: "none" } : { gap: 8 }}>
      <Text style={[styles.title, { color: colors.foreground }]}>{visible.summary}</Text>
      {!visible.document && !!visible.context && <Text style={{ color: colors.foregroundMuted }}>{visible.context}</Text>}
      {visible.meanwhile === "other_work" && <Text style={{ color: colors.foregroundMuted }}>The agent can continue work that does not depend on these answers.</Text>}
      <SurfaceQuestions key={JSON.stringify([host.id, surfaceId])} hostId={host.id} record={visible} theme={theme} refresh={refresh} />
    </View>}
  </View>;
}

export function registerSurfaceTimeline(client: PluginClientContext) {
  const removeRenderer = client.addTimelineRenderer({ kind: SURFACE_KIND, version: 1, schema, Component: SurfaceCard });
  const removeTransformer = client.addTimelineTransformer(surfaceTransformer);
  return async () => {
    await Promise.all([removeTransformer(), removeRenderer()]);
  };
}
