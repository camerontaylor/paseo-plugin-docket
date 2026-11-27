import { describe, expect, it } from "vitest";
import { surfaceTransformer } from "./surface-anchor";

const text = "[docket s_abc123]\n\nWhich queue?";
const content = [{ type: "text", text }];

function transform(output: unknown, status: "running" | "completed" | "failed" = "completed", name = "mcp__paseo__docket_show") {
  return surfaceTransformer.transform({
    phase: "complete",
    item: {
      type: "tool_call", callId: "a", name, detail: { type: "unknown", input: null, output },
      ...(status === "failed" ? { status, error: "failed" } : { status, error: null }),
    },
  });
}

describe("Docket timeline anchor", () => {
  it.each([text, content, { content }, JSON.stringify({ content })])("keeps the text form from %j", (output) => {
    expect(transform(output)).toEqual({ items: [{
      type: "plugin", kind: "surface", version: 1, data: { surfaceId: "s_abc123", fallback: "Which queue?" },
    }] });
  });

  it.each([
    { output: { surface: "s_abc123", status: "open", rendered: "Which queue?\n", open: [] } },
    { structuredContent: { surface: "s_abc123", status: "open", rendered: "Which queue?", open: [] } },
  ])("anchors the structured result a provider stored: %j", (output) => {
    expect(transform(output)).toEqual({ items: [{
      type: "plugin", kind: "surface", version: 1, data: { surfaceId: "s_abc123", fallback: "Which queue?" },
    }] });
  });

  it("ignores structured results without a valid surface id and status", () => {
    expect(transform({ output: { surface: "s_12345", status: "open" } })).toBeUndefined();
    expect(transform({ output: { surface: "s_abc123" } })).toBeUndefined();
    expect(transform({ input: { surface: "s_abc123", status: "open" } })).toBeUndefined();
  });

  it("leaves running, failed, unrelated and unanchored calls to the host", () => {
    expect(transform(text, "running")).toBeUndefined();
    expect(transform(text, "failed")).toBeUndefined();
    expect(transform(text, "completed", "docket_close")).toBeUndefined();
    expect(transform("Warning\n" + text)).toBeUndefined();
    expect(transform("[docket s_12345]")).toBeUndefined();
    expect(transform({ input: text })).toBeUndefined();
  });
});
