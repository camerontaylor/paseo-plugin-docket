import { Pressable, Text } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";

type Theme = PluginHostProps["theme"];

export function InboxButton({ label, onPress, disabled, selected, theme, role = "button" }: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  selected?: boolean;
  role?: "button" | "tab";
  theme: Theme;
}) {
  return <Pressable accessibilityRole={role} accessibilityState={{ disabled, selected }}
    disabled={disabled} onPress={onPress}
    style={{ padding: 8, borderRadius: 5, backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
      opacity: disabled ? 0.55 : 1 }}>
    <Text style={{ color: selected ? theme.colors.accentForeground : theme.colors.foreground }}>{label}</Text>
  </Pressable>;
}

export const buttonRow = { flexDirection: "row", flexWrap: "wrap", gap: 6 } as const;
