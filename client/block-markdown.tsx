import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { refsInMarkdown } from "../shared/evidence";
import { parseMarkdown, type Inline } from "../shared/diagram/markdown";
import { BlockCode } from "./block-code";
import { Diagram } from "./block-diagram";

// Adapted from genui's MarkdownText. All content is rendered with native Text
// and View. Only user-activated external links can leave the card.
export function BlockMarkdown({ text, theme, excerpt }: {
  text: string; theme: PluginTheme; excerpt: (ref: string) => ReactNode;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const [open, setOpen] = useState<string>();
  const c = theme.colors;
  const body = { color: c.foreground, fontSize: 13.5, lineHeight: 20 };

  function spans(content: Inline[]) {
    return content.map((span, index) => {
      if (span.kind === "bold") return <Text key={index} style={{ fontWeight: "bold" }}>{span.text}</Text>;
      if (span.kind === "italic") return <Text key={index} style={{ fontStyle: "italic" }}>{span.text}</Text>;
      if (span.kind === "link") return <Text key={index} accessibilityRole="link"
        onPress={() => void openExternalUrl(span.url).catch(() => undefined)}
        style={{ color: c.accent, textDecorationLine: "underline" }}>{span.text}</Text>;
      if (span.kind === "code") {
        const ref = refsInMarkdown("`" + span.text + "`")[0];
        return <Text key={index} accessibilityRole={ref ? "button" : undefined}
          onPress={ref ? () => setOpen(open === ref ? undefined : ref) : undefined}
          style={{ fontFamily: "monospace", fontSize: 12, backgroundColor: c.surface2, color: ref ? c.accent : c.foreground }}>
          {span.text}
        </Text>;
      }
      return <Text key={index}>{span.text}</Text>;
    });
  }

  return <View style={{ gap: 6, minWidth: 0 }}>
    {blocks.map((block, index) => {
      if (block.kind === "code") {
        const code = <BlockCode text={block.text} lang={block.language} diff={block.language === "diff"} theme={theme} />;
        return <Fragment key={index}>{block.language.toLowerCase() === "mermaid"
          ? <Diagram source={block.text} theme={theme} fallback={code} /> : code}</Fragment>;
      }
      if (block.kind === "rule") return <View key={index} style={{ borderBottomWidth: 1, borderColor: c.border }} />;
      if (block.kind === "table") return <ScrollView key={index} horizontal>
        <View>{block.rows.map((row, rowIndex) => <View key={rowIndex} style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: c.border }}>
          {row.map((cell, column) => <Text selectable key={column} style={{ ...body, width: 148, padding: 6, fontWeight: rowIndex === 0 ? "bold" : "normal" }}>{spans(cell)}</Text>)}
        </View>)}</View>
      </ScrollView>;
      if (block.kind === "bullet" || block.kind === "ordered") return <View key={index}>
        {block.items.map((item, i) => <Text selectable key={i} style={body}>{block.kind === "bullet" ? "• " : `${block.start + i}. `}{spans(item)}</Text>)}
      </View>;
      return <Text selectable key={index} style={[body, block.kind === "heading" && { fontSize: Math.max(14, 20 - block.level), fontWeight: "bold" },
        block.kind === "quote" && { paddingLeft: 12, color: c.foregroundMuted }]}>{spans(block.content)}</Text>;
    })}
    {open && excerpt(open)}
  </View>;
}
