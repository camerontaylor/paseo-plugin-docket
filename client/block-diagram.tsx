import type { PluginTheme } from "@getpaseo/plugin";
import React, { useMemo, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { parseFlowchart, type Flowchart, type NodeShape } from "../shared/diagram/flowchart";
import {
  layoutFlowchart,
  layoutSequence,
  layoutSequenceMessage,
  type FlowLayout,
  type LaidOutEdge,
  type LaidOutNode,
} from "../shared/diagram/layout";
import { parseSequence, type SeqEvent, type SequenceDiagram } from "../shared/diagram/sequence";
const arrows = { up: "▲", down: "▼", left: "◀", right: "▶" };
type Size = { width: number; height: number };

type ParsedDiagram =
  | { kind: "flow"; layout: FlowLayout; skipped: Flowchart["skipped"] }
  | { kind: "sequence"; diagram: SequenceDiagram; size: Size }
  | { kind: "unsupported" };

type DrawableDiagram = Exclude<ParsedDiagram, { kind: "unsupported" }>;

function parseDiagram(source: string): ParsedDiagram {
  const flow = parseFlowchart(source);
  if (flow && flow.nodes.length > 0 && flow.nodes.length <= 100 && flow.edges.length <= 200 && !flow.skipped.length) {
    return { kind: "flow", layout: layoutFlowchart(flow), skipped: flow.skipped };
  }
  const sequence = parseSequence(source);
  if (sequence && sequence.participants.length > 0 && sequence.participants.length <= 50 && sequence.events.length <= 150) {
    const box = layoutSequence(sequence.participants, sequence.events.length);
    return { kind: "sequence", diagram: sequence, size: { width: box.width, height: box.height } };
  }
  return { kind: "unsupported" };
}


export function Diagram({ source, theme, fallback }: { source: string; theme: PluginTheme; fallback: ReactNode }) {
  const parsed = useMemo(() => parseDiagram(source), [source]);
  if (parsed.kind === "unsupported" || (parsed.kind === "flow" ? parsed.skipped.length : parsed.diagram.skipped.length)) return fallback;
  return <ScrollView horizontal>
    {parsed.kind === "flow" ? <View style={{ width: parsed.layout.width, height: parsed.layout.height }}>
      {parsed.layout.edges.map((edge, index) => <EdgeView key={index} edge={edge} theme={theme} />)}
      {parsed.layout.nodes.map((node) => <NodeView key={node.id} node={node} theme={theme} />)}
    </View> : <SequenceView diagram={parsed.diagram} size={parsed.size} theme={theme} />}
  </ScrollView>;
}

function radiusFor(shape: NodeShape, node: LaidOutNode): number {
  if (shape === "circle") return node.width / 2;
  if (shape === "stadium") return node.height / 2;
  if (shape === "round") return 12;
  return 6;
}

function NodeView({ node, theme }: { node: LaidOutNode; theme: PluginTheme }) {
  return (
    <View
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        borderRadius: radiusFor(node.shape, node),
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 8,
      }}
    >
      <Text
        numberOfLines={2}
        style={{
          color: theme.colors.foreground,
          fontSize: 12,
          textAlign: "center",
        }}
      >
        {node.label}
      </Text>
    </View>
  );
}

function EdgeView({ edge, theme }: { edge: LaidOutEdge; theme: PluginTheme }) {
  const color = theme.colors.foregroundMuted;
  return (
    <>
      {edge.segments.map((seg, i) => (
        <View
          key={i}
          style={{
            position: "absolute",
            left: seg.x,
            top: seg.y,
            width: seg.width,
            height: seg.height,
            backgroundColor: color,
          }}
        />
      ))}
      {edge.arrowAt && <Text style={{
        position: "absolute", left: edge.arrowAt.x - 6, top: edge.arrowAt.y - 6,
        width: 12, lineHeight: 12, fontSize: 10, textAlign: "center", color,
      }}>{arrows[edge.arrowAt.direction]}</Text>}
      {edge.label && edge.labelAt ? (
        <View
          style={{
            position: "absolute",
            left: edge.labelAt.x - 40,
            top: edge.labelAt.y - 10,
            minWidth: 80,
            alignItems: "center",
          }}
        >
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              backgroundColor: theme.colors.surface1,
              fontSize: 10.5,
              paddingHorizontal: 4,
            }}
          >
            {edge.label}
          </Text>
        </View>
      ) : null}
    </>
  );
}

function SequenceView({
  diagram,
  size,
  theme,
}: {
  diagram: SequenceDiagram;
  size: Size;
  theme: PluginTheme;
}) {
  const box = layoutSequence(diagram.participants, diagram.events.length);
  const centerById = new Map(box.columns.map((col) => [col.id, col.centerX]));

  return (
    <View style={{ width: size.width, height: size.height }}>
      {box.columns.map((col) => (
        <React.Fragment key={col.id}>
          <View
            style={{
              position: "absolute",
              left: col.centerX - 1,
              top: box.headerHeight,
              width: 1.5,
              height: size.height - box.headerHeight,
              backgroundColor: theme.colors.border,
            }}
          />
          <View
            style={{
              position: "absolute",
              left: col.centerX - col.width / 2,
              top: 4,
              width: col.width,
              height: box.headerHeight - 8,
              borderRadius: 6,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 6,
            }}
          >
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
              {col.label}
            </Text>
          </View>
        </React.Fragment>
      ))}
      {diagram.events.map((ev: SeqEvent, idx: number) => {
        const row = box.rows[idx];
        const y = (row?.y ?? box.headerHeight) + 20;
        if (ev.kind === "note") {
          const firstId = ev.over[0] ?? "";
          const cx = centerById.get(firstId) ?? 60;
          return (
            <View
              key={idx}
              style={{
                position: "absolute",
                left: Math.max(0, cx - 60),
                top: y - 12,
                width: 120,
                padding: 4,
                borderRadius: 4,
                backgroundColor: theme.colors.surface2,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.border,
              }}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, textAlign: "center" }}>
                {ev.text}
              </Text>
            </View>
          );
        }
        const message = layoutSequenceMessage(ev, centerById.get(ev.from)!, centerById.get(ev.to)!);
        if (!message) return null;
        const color = theme.colors.accent;
        const { arrow, strokes } = message;
        return (
          <View key={idx} style={{ position: "absolute", left: message.left, top: y - 14, width: message.width }}>
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 11, textAlign: "center" }}>
              {ev.text}
            </Text>
            <View style={{ height: 12, justifyContent: "center" }}>
              {strokes.map(({ x, width }) => <View key={x} style={{
                position: "absolute", left: x, width, height: 1.5, backgroundColor: color,
              }} />)}
              {arrow?.kind === "async" ? <View style={{
                position: "absolute", left: arrow.x - (arrow.direction === "right" ? 7 : 0),
                top: 3, width: 8, height: 1.5, backgroundColor: color,
                transform: [{ rotate: arrow.direction === "right" ? "30deg" : "-30deg" }],
              }} /> : arrow && <Text style={{
                position: "absolute", left: arrow.x - 6, textAlign: "center", width: 12, lineHeight: 12, fontSize: 10, color,
              }}>{arrow.kind === "cross" ? "×" : arrows[arrow.direction]}</Text>}
            </View>
          </View>
        );
      })}
    </View>
  );
}
