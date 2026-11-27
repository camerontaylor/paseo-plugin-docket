import type { PluginTheme } from "@getpaseo/plugin";
import * as ui from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

// Docket's small design kit. Everything is drawn from the host theme tokens so
// light and dark themes, and any custom Paseo theme, carry through unchanged.

type Colors = PluginTheme["colors"];
export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 6, md: 10, pill: 999 } as const;
export const type = {
  title: { fontSize: 15, lineHeight: 21, fontWeight: "600" },
  body: { fontSize: 14, lineHeight: 20 },
  meta: { fontSize: 12.5, lineHeight: 17 },
  label: { fontSize: 11.5, lineHeight: 15, fontWeight: "600", letterSpacing: 0.4, textTransform: "uppercase" },
} as const;

// The SDK draws icons at runtime; older hosts and tests have none, so icons are optional.
const HostIcon = (ui as Partial<typeof ui>).Icon;

export function Glyph({ name, color, size = 16 }: { name: string; color: string; size?: number }) {
  if (!HostIcon) return null;
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <HostIcon name={name} size={size} color={color} />
  </View>;
}

/** Mixes a theme colour with transparency when it is a hex or rgb colour; undefined otherwise. */
export function tint(color: string | undefined, alpha: number): string | undefined {
  if (!color) return undefined;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split("").map((d) => d + d).join("") : hex[1];
    return `#${digits}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})` : undefined;
}

export function toneColor(colors: Colors, tone: Tone) {
  switch (tone) {
    case "accent": return colors.accent;
    case "success": return colors.statusSuccess;
    case "warning": return colors.statusWarning;
    case "danger": return colors.statusDanger;
    default: return colors.foregroundMuted;
  }
}

/** A small status label. Colour is never the only signal: the text names the state. */
export function Pill({ colors, tone = "neutral", label, icon }: { colors: Colors; tone?: Tone; label: string; icon?: string }) {
  const color = toneColor(colors, tone);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start",
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill,
    backgroundColor: tint(color, 0.14) ?? colors.surface2 }}>
    {icon && <Glyph name={icon} color={color} size={12} />}
    <Text style={{ ...type.meta, fontWeight: "600", color }}>{label}</Text>
  </View>;
}

type Interaction = { pressed: boolean; hovered?: boolean; focused?: boolean };
export type ButtonVariant = "primary" | "secondary" | "ghost" | "quiet" | "danger";

/** One button style for every Docket action. A visible ring marks keyboard focus. */
export function Button({ colors, label, onPress, variant = "secondary", icon, disabled, selected, role = "button",
  accessibilityLabel, compact, grow }: {
  colors: Colors; label: string; onPress(): void; variant?: ButtonVariant; icon?: string; disabled?: boolean;
  selected?: boolean; role?: "button" | "tab"; accessibilityLabel?: string; compact?: boolean; grow?: boolean;
}) {
  const fg = variant === "primary" ? colors.accentForeground
    : variant === "danger" ? colors.statusDanger
    : variant === "ghost" ? colors.accent
    : variant === "quiet" ? colors.foregroundMuted : colors.foreground;
  return <Pressable accessibilityRole={role} accessibilityLabel={accessibilityLabel}
    accessibilityState={{ disabled: !!disabled, selected }} disabled={disabled} onPress={onPress}
    style={(state) => {
      const { pressed, hovered, focused } = state as Interaction;
      const base = variant === "primary" ? colors.accent
        : variant === "secondary" ? colors.surface2 : "transparent";
      const active = hovered || pressed;
      return {
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
        minHeight: compact ? 30 : 36, paddingHorizontal: compact ? 10 : 14, borderRadius: radius.sm,
        borderWidth: 1, flexGrow: grow ? 1 : 0,
        borderColor: focused ? colors.accent : variant === "secondary" ? colors.border : "transparent",
        backgroundColor: active && variant !== "primary" ? (tint(fg, 0.1) ?? colors.surface2) : base,
        opacity: disabled ? 0.45 : pressed && variant === "primary" ? 0.85 : 1,
        outlineStyle: focused ? "solid" : undefined, outlineWidth: focused ? 2 : undefined,
        outlineColor: focused ? tint(colors.accent, 0.45) : undefined, outlineOffset: focused ? 1 : undefined,
      };
    }}>
    {icon && <Glyph name={icon} color={fg} size={compact ? 14 : 15} />}
    <Text numberOfLines={1} style={{ ...type.body, fontWeight: variant === "primary" ? "600" : "500", color: fg }}>{label}</Text>
  </Pressable>;
}

/** A tinted callout for warnings, errors and quiet status that needs a sentence. */
export function Notice({ colors, tone = "neutral", icon, children, action }: {
  colors: Colors; tone?: Tone; icon?: string; children: ReactNode; action?: ReactNode;
}) {
  const color = toneColor(colors, tone);
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm,
    paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.sm, borderWidth: 1,
    borderColor: tint(color, 0.35) ?? colors.border, backgroundColor: tint(color, 0.08) ?? colors.surface1 }}>
    {icon && <Glyph name={icon} color={color} />}
    <View style={{ flex: 1, minWidth: 160, gap: 2 }}>{children}</View>
    {action}
  </View>;
}

export function NoticeText({ colors, children, strong }: { colors: Colors; children: ReactNode; strong?: boolean }) {
  return <Text style={{ ...type.body, color: colors.foreground, fontWeight: strong ? "600" : "400" }}>{children}</Text>;
}

/** An uppercase group label with an optional count beside it. */
export function SectionLabel({ colors, title, count }: { colors: Colors; title: string; count?: number }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.sm }}>
    <Text accessibilityRole="header" style={{ ...type.label, color: colors.foregroundMuted }}>{title}</Text>
    {count !== undefined && <Text style={{ ...type.meta, color: colors.foregroundMuted }}>{count}</Text>}
  </View>;
}

export function EmptyState({ colors, icon, title, detail }: { colors: Colors; icon: string; title: string; detail?: string }) {
  return <View style={{ alignItems: "center", gap: space.sm, paddingVertical: 40, paddingHorizontal: space.lg }}>
    <Glyph name={icon} color={colors.foregroundMuted} size={28} />
    <Text style={{ ...type.title, color: colors.foreground, textAlign: "center" }}>{title}</Text>
    {!!detail && <Text style={{ ...type.body, color: colors.foregroundMuted, textAlign: "center", maxWidth: 360 }}>{detail}</Text>}
  </View>;
}

export const row = { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm } as const;

/** The host's input chrome, shared by every Docket text field. */
export function inputStyle(colors: Colors, focused = false) {
  return {
    ...type.body, color: colors.foreground, backgroundColor: colors.surface0,
    borderWidth: 1, borderColor: focused ? colors.accent : colors.border, borderRadius: radius.sm,
    paddingHorizontal: space.md, paddingVertical: 8, minHeight: 38,
  } as const;
}

/** A filter or segmented choice. Selected chips use the accent colour and say so to assistive tech. */
export function Chip({ colors, label, selected, onPress, role = "button" }: {
  colors: Colors; label: string; selected?: boolean; onPress(): void; role?: "button" | "tab" | "radio";
}) {
  return <Pressable accessibilityRole={role} accessibilityState={role === "radio" ? { checked: !!selected } : { selected: !!selected }}
    onPress={onPress} style={(state) => {
      const { hovered, focused } = state as Interaction;
      return {
        minHeight: 30, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, justifyContent: "center",
        borderColor: selected || focused ? colors.accent : colors.border,
        backgroundColor: selected ? tint(colors.accent, 0.14) ?? colors.surface2 : hovered ? colors.surface2 : "transparent",
        outlineStyle: focused ? "solid" : undefined, outlineWidth: focused ? 2 : undefined,
        outlineColor: focused ? tint(colors.accent, 0.45) : undefined,
      };
    }}>
    <Text numberOfLines={1} style={{ ...type.meta, fontWeight: "600", color: selected ? colors.accent : colors.foreground }}>{label}</Text>
  </Pressable>;
}
