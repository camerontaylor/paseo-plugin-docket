import { Text, View } from "react-native";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import { isSurfaceId } from "../shared/ids";
import { SurfaceQuestions } from "./surface-questions";
import { SURFACE_KIND, surfaceTransformer } from "./surface-anchor";
import { useSurface } from "./use-surface";
import { Button, Glyph, Notice, NoticeText, Pill, radius, row, space, type, type Tone } from "./kit";

const schema = z.object({ surfaceId: z.string().refine(isSurfaceId), fallback: z.string().optional() });

function SurfaceCard({ host, item, theme, agentId }: PluginTimelineItemProps<z.output<typeof schema>>) {
  const { surfaceId, fallback } = item.data;
  const { record, unavailable, refresh } = useSurface(host.id, surfaceId);
  const colors = theme.colors;
  const visible = record?.agentId === agentId ? record : undefined;
  const open = visible ? Object.values(visible.questions).filter((question) => question.state === "open").length : 0;
  const status: [string, Tone, string] | undefined = !visible ? undefined
    : visible.orphanedAt ? ["Agent stopped", "warning", "CircleSlash"]
    : open ? [open === 1 ? "1 open question" : `${open} open questions`, "accent", "MessageCircleQuestion"]
    : visible.closed ? ["Closed", "neutral", "XCircle"] : ["Answered", "success", "CheckCircle2"];

  return <View style={{ gap: space.md, padding: space.lg, borderRadius: radius.md, borderWidth: 1, minWidth: 0, flexShrink: 1,
    borderColor: colors.border, backgroundColor: colors.surface1 }}>
    <View style={[row, { justifyContent: "space-between" }]}>
      <View style={[row, { gap: 6 }]}>
        <Glyph name="ClipboardList" color={colors.accent} size={15} />
        <Text style={{ ...type.label, color: colors.foregroundMuted }}>Docket</Text>
      </View>
      {status && <Pill colors={colors} tone={status[1]} icon={status[2]} label={status[0]} />}
    </View>
    {(unavailable || !visible) && <>
      <Notice colors={colors} tone={unavailable ? "warning" : "neutral"} icon={unavailable ? "CloudOff" : record === undefined ? "Loader" : "Info"}
        action={unavailable ? <Button colors={colors} compact icon="RotateCw" label="Refresh questions" onPress={() => void refresh()} /> : undefined}>
        <NoticeText colors={colors}>
          {unavailable ? "Docket server unavailable" : record === undefined ? "Loading questions…" : "Surface unavailable"}
        </NoticeText>
      </Notice>
      {!!fallback && <Text selectable style={{ ...type.body, color: colors.foreground }}>{fallback}</Text>}
    </>}
    {visible && <View style={unavailable ? { display: "none" } : { gap: space.md }}>
      <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.foreground }}>{visible.summary}</Text>
      {!visible.document && !!visible.context && <Text style={{ ...type.body, color: colors.foregroundMuted }}>{visible.context}</Text>}
      {visible.meanwhile === "other_work" && open > 0 && <View style={row}>
        <Pill colors={colors} icon="Activity" label="Agent keeps working on other things meanwhile" />
      </View>}
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
