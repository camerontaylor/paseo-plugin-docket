import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView, Text, View } from "react-native";

const syntaxLanguages = /^(?:js|jsx|ts|tsx|javascript|typescript|json|py|python|sh|bash|shell|sql|go|rust|rs|java|c|cpp|css|yaml|yml|toml)$/i;
const syntaxToken = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|return|function|class|import|export|from|if|else|def|for|while|await|async|true|false|null|None|SELECT|WHERE)\b|\b\d+(?:\.\d+)?\b)/g;

// Adapted from genui's Code, Snippet and Diff drawing. The document only
// supplies text and language. A snapshot supplies the first line number.
export function BlockCode({ text, theme, lang, from, diff }: {
  text: string; theme: PluginTheme; lang?: string; from?: number; diff?: boolean;
}) {
  const c = theme.colors;
  const mono = { fontFamily: "monospace", fontSize: 12, lineHeight: 18 };
  const highlight = !diff && syntaxLanguages.test(lang ?? "");
  const lines = from !== undefined || diff ? text.split("\n") : [text];
  return <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface2, minWidth: 0 }}>
    {!!lang && <Text style={{ ...mono, color: c.foregroundMuted, paddingHorizontal: 10 }}>{lang}</Text>}
    <ScrollView horizontal>
      <View style={{ padding: 10 }}>
        {lines.map((line, index) => {
          const color = diff && line.startsWith("+") && !line.startsWith("+++ ") ? c.statusSuccess
            : diff && line.startsWith("-") && !line.startsWith("--- ") ? c.statusDanger
            : diff && line.startsWith("@@") ? c.accent : c.foreground;
          return <View key={index} style={{ flexDirection: "row", gap: 10 }}>
            {from !== undefined && <Text style={{ ...mono, color: c.foregroundMuted, minWidth: 28 }}>{from + index}</Text>}
            <Text selectable style={{ ...mono, color }}>{highlight ? line.split(syntaxToken).map((part, index) => index % 2
              ? <Text key={index} style={{ color: /^["']/.test(part) ? c.statusSuccess : c.accent }}>{part}</Text>
              : part) : line || " "}</Text>
          </View>;
        })}
      </View>
    </ScrollView>
  </View>;
}
