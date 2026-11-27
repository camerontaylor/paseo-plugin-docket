import type { PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { isSurfaceId } from "../shared/ids";

export const SURFACE_KIND = "surface";

function outputTexts(output: unknown): string[] {
  if (typeof output === "string") {
    // Some providers serialize the MCP result as JSON before storing it.
    if (/^\s*[\[{]/.test(output) && !output.startsWith("[docket ")) {
      try {
        return outputTexts(JSON.parse(output));
      } catch {
        return [];
      }
    }
    return [output];
  }
  if (Array.isArray(output)) {
    return output.flatMap((entry) =>
      entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : []);
  }
  if (output && typeof output === "object" && "content" in output) {
    return outputTexts(output.content);
  }
  return [];
}

/**
 * Claude stores the MCP structured result instead of its text, as
 * `{ output: { surface, status, rendered, open } }`. Accept that shape, and the
 * same object under `structuredContent`, when it names a valid surface id.
 */
function structuredAnchor(output: unknown, depth = 0): { surfaceId: string; fallback: string } | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output) || depth > 2) return;
  const value = output as Record<string, unknown>;
  if (typeof value.surface === "string" && isSurfaceId(value.surface) && typeof value.status === "string") {
    return { surfaceId: value.surface, fallback: typeof value.rendered === "string" ? value.rendered.trim() : "" };
  }
  return structuredAnchor(value.structuredContent, depth + 1) ?? structuredAnchor(value.output, depth + 1);
}

export const surfaceTransformer: PluginTimelineTransformerContribution<"tool_call"> = {
  id: "surface",
  query: { itemType: "tool_call" },
  transform({ item }) {
    if (!item.name.endsWith("docket_show") || item.status !== "completed" || item.detail.type !== "unknown") return;
    for (const text of outputTexts(item.detail.output)) {
      const marker = /^\[docket (s_[a-z0-9]{6})\](?:\r?\n|$)/.exec(text);
      if (!marker) continue;
      const surfaceId = marker[1];
      const fallback = text.slice(marker[0].length).trim();
      return { items: [{ type: "plugin", kind: SURFACE_KIND, version: 1, data: { surfaceId, fallback } }] };
    }
    const structured = structuredAnchor(item.detail.output);
    if (structured) return { items: [{ type: "plugin", kind: SURFACE_KIND, version: 1, data: structured }] };
    // Leave the host's tool row visible when the result has no usable anchor.
  },
};
