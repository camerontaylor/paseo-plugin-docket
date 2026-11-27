import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Button, type ButtonVariant } from "./kit";

type Theme = PluginHostProps["theme"];

/** The inbox's tab and navigation buttons, drawn with Docket's shared button. */
export function InboxButton({ label, onPress, disabled, selected, theme, role = "button", variant, icon }: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  selected?: boolean;
  role?: "button" | "tab";
  theme: Theme;
  variant?: ButtonVariant;
  icon?: string;
}) {
  return <Button colors={theme.colors} label={label} onPress={onPress} disabled={disabled} selected={selected} role={role}
    icon={icon} compact={role === "tab"} variant={variant ?? (role === "tab" ? (selected ? "primary" : "quiet") : "secondary")} />;
}

export const buttonRow = { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 } as const;
