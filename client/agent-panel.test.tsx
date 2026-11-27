import type { PluginAgentPanelProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useState } from "react";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { Summary } from "../shared/projections";
import type { SurfaceRecord } from "../shared/record";
import { registerAgentPanel } from "./agent-panel";
import { useSurface } from "./use-surface";

vi.mock("react-native", () => ({
  Keyboard: { dismiss: vi.fn() }, View: "View", Text: "Text", ScrollView: "ScrollView", Pressable: "Pressable",
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ Icon: undefined }));
vi.mock("./agent-panel-model", async (load) => ({
  ...await load<typeof import("./agent-panel-model")>(), registerComposerPills: () => () => undefined,
}));
vi.mock("./use-surface", () => ({ useSurface: vi.fn() }));
vi.mock("./surface-questions", () => ({
  // Stands in for the real controls: local state that is lost if the component unmounts.
  SurfaceQuestions: () => {
    const [draft, setDraft] = useState("");
    return <button onClick={() => setDraft("unsent answer")}>{draft || "edit answer"}</button>;
  },
}));

const summary: Summary = {
  id: "s_aaaaaa", rev: 1, agentId: "agent", workspaceId: "w", summary: "Question", status: "open",
  createdAt: "2026-11-22T00:00:00Z", resolvedAt: null, openQuestions: 1, pendingDeliveries: 0,
  replacedBy: null, revises: null, compacted: false,
};
vi.mock("./hub", () => {
  const entry = { fresh: true, summaries: new Map() };
  const snapshot = new Map([["host", entry]]);
  return { getHub: () => ({ subscribe: () => () => undefined, getSnapshot: () => snapshot }), entry };
});

function hiddenAncestor(node: ReactTestInstance) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.props.style?.display === "none") return parent;
  }
}

it("keeps unsaved answer state across collapse and host unavailability", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { entry } = await import("./hub") as unknown as { entry: { summaries: Map<string, Summary> } };
  entry.summaries.set(summary.id, summary);
  let unavailable = false;
  vi.mocked(useSurface).mockImplementation(() => ({
    record: { id: summary.id } as SurfaceRecord, unavailable, refresh: vi.fn(),
  }));
  const addAgentPanel = vi.fn<PluginClientContext["addAgentPanel"]>(() => vi.fn());
  registerAgentPanel({ addAgentPanel } as unknown as PluginClientContext);
  const Panel = addAgentPanel.mock.calls[0][0].Component;
  const props = { host: { id: "host" }, params: { agentId: "agent" }, theme: { colors: {} } } as unknown as PluginAgentPanelProps;
  let tree!: ReturnType<typeof create>;
  try {
    await act(() => { tree = create(<Panel {...props} />); });
    const editor = () => tree.root.findByType("button");
    const press = (label: string) => act(() => tree.root.findAll((node) => node.type === "Pressable"
      && node.props.accessibilityLabel?.startsWith(label))[0].props.onPress());
    await act(() => editor().props.onClick());
    expect(editor().props.children).toBe("unsent answer");

    await press("Collapse");
    expect(hiddenAncestor(editor())?.props).toMatchObject({
      accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants", pointerEvents: "none",
    });
    await press("Answer");
    expect(hiddenAncestor(editor())).toBeUndefined();
    expect(editor().props.children).toBe("unsent answer");

    unavailable = true;
    await act(() => tree.update(<Panel {...props} />));
    expect(hiddenAncestor(editor())).toBeDefined();
    expect(tree.root.findAll((node) => node.type === "Text" && node.props.children === "Docket server unavailable")).toHaveLength(1);
    unavailable = false;
    await act(() => tree.update(<Panel {...props} />));
    expect(hiddenAncestor(editor())).toBeUndefined();
    expect(editor().props.children).toBe("unsent answer");
  } finally {
    await act(() => tree?.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps a row's controls when its surface moves from open to resolved", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { entry } = await import("./hub") as unknown as { entry: { summaries: Map<string, Summary> } };
  entry.summaries.clear();
  entry.summaries.set("s_bbbbbb", { ...summary, id: "s_bbbbbb", status: "resolved", openQuestions: 0, resolvedAt: "2026-11-23T00:00:00Z" });
  entry.summaries.set(summary.id, summary);
  vi.mocked(useSurface).mockImplementation(() => ({ record: { id: summary.id } as SurfaceRecord, unavailable: false, refresh: vi.fn() }));
  const addAgentPanel = vi.fn<PluginClientContext["addAgentPanel"]>(() => vi.fn());
  registerAgentPanel({ addAgentPanel } as unknown as PluginClientContext);
  const Panel = addAgentPanel.mock.calls[0][0].Component;
  const props = { host: { id: "host" }, params: { agentId: "agent" }, theme: { colors: {} } } as unknown as PluginAgentPanelProps;
  let tree!: ReturnType<typeof create>;
  try {
    await act(() => { tree = create(<Panel {...props} />); });
    await act(() => tree.root.findByType("button").props.onClick());
    entry.summaries.set(summary.id, { ...summary, status: "resolved", openQuestions: 0, resolvedAt: "2026-11-24T00:00:00Z" });
    await act(() => tree.update(<Panel {...props} />));
    expect(tree.root.findByType("button").props.children).toBe("unsent answer");
  } finally {
    await act(() => tree?.unmount());
    entry.summaries.clear();
    vi.unstubAllGlobals();
  }
});

it("shows retained context when a compacted surface is expanded", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { entry } = await import("./hub") as unknown as { entry: { summaries: Map<string, Summary> } };
  entry.summaries.clear();
  entry.summaries.set(summary.id, { ...summary, status: "resolved", openQuestions: 0, compacted: true, context: "Kept context" });
  vi.mocked(useSurface).mockImplementation(() => ({
    record: { id: summary.id, document: null, context: "Kept context" } as SurfaceRecord, unavailable: false, refresh: vi.fn(),
  }));
  const addAgentPanel = vi.fn<PluginClientContext["addAgentPanel"]>(() => vi.fn());
  registerAgentPanel({ addAgentPanel } as unknown as PluginClientContext);
  const Panel = addAgentPanel.mock.calls[0][0].Component;
  const props = { host: { id: "host" }, params: { agentId: "agent" }, theme: { colors: {} } } as unknown as PluginAgentPanelProps;
  let tree!: ReturnType<typeof create>;
  try {
    await act(() => { tree = create(<Panel {...props} />); });
    const full = () => tree.root.findAll((node) => node.type === "Text" && node.props.children === "Kept context"
      && node.props.numberOfLines === undefined);
    expect(full()).toHaveLength(0);
    await act(() => tree.root.findAll((node) => node.type === "Pressable"
      && node.props.accessibilityLabel === "View answers: Question")[0].props.onPress());
    expect(full()).toHaveLength(1);
  } finally {
    await act(() => tree?.unmount());
    entry.summaries.clear();
    vi.unstubAllGlobals();
  }
});
