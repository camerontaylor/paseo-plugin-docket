import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { Summary } from "../shared/projections";
import type { SurfaceRecord } from "../shared/record";
import { registerInbox } from "./inbox";
import { useDocketInbox } from "./use-docket";

vi.mock("react-native", () => ({
  View: "View", Text: "Text", ScrollView: "ScrollView", TextInput: "TextInput", Pressable: "Pressable",
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: () => null, useWorkspace: () => null, useAgents: () => [], useWorkspaces: () => [],
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ WorkspaceRowBadge: undefined }));
vi.mock("./use-docket", () => ({ useDocketInbox: vi.fn() }));

it("preserves expanded, unsaved and conflict state when a delivery changes sections", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const theme = { colors: {} } as PluginScreenProps["theme"];
  const summary: Summary = {
    id: "s_aaaaaa", rev: 1, agentId: "agent", workspaceId: null, summary: "Question",
    status: "open", createdAt: "2026-11-22T00:00:00Z", resolvedAt: null, openQuestions: 1,
    pendingDeliveries: 1, replacedBy: null, revises: null, compacted: false,
  };
  const host = (serverId: string) => ({
    serverId, label: serverId, status: "online" as const, docketStatus: "ready" as const,
    summaries: undefined, updatedAt: undefined,
  });
  function update(hostId: string, pendingDeliveries: number) {
    vi.mocked(useDocketInbox).mockReturnValue({
      sources: [host(hostId)], cards: [{ hostId, summary: { ...summary, pendingDeliveries } }],
      count: { kind: "exact", value: 1 },
    });
  }
  const refresh = vi.fn();
  function Questions() {
    const [draft, setDraft] = useState("");
    const [conflict, setConflict] = useState(false);
    return <button onClick={() => { setDraft("unsent answer"); setConflict(true); }}>
      {draft || "edit answer"}{conflict && " · conflict"}
    </button>;
  }
  const addScreen = vi.fn<PluginClientContext["addScreen"]>(() => vi.fn());
  registerInbox({ addScreen, addSidebarHeaderItem: () => vi.fn() } as unknown as PluginClientContext, {
    useSurface: () => ({ record: { summary: "Question", compactedAt: null } as SurfaceRecord, unavailable: false, refresh }),
    SurfaceQuestions: Questions,
    Decisions: () => null,
  });
  const Screen = addScreen.mock.calls[0][0].Component;
  const screen = <Screen {...({ theme } as PluginScreenProps)} />;
  update("a", 1);
  let renderer!: ReturnType<typeof create>;
  try {
    await act(() => { renderer = create(screen); });
    const press = async (label: string) => {
      const button = renderer.root.findAll((node) => node.type === "Pressable")
        .find((node) => node.findByType("Text").props.children === label);
      expect(button).toBeDefined();
      await act(() => button!.props.onPress());
    };
    const heading = () => renderer.root.findByProps({ accessibilityRole: "header" }).props.children;
    expect(heading()).toBe("Not delivered");
    await press("Answer in place");
    await act(() => renderer.root.findByType("button").props.onClick());

    update("a", 0);
    await act(() => renderer.update(<Screen {...({ theme } as PluginScreenProps)} />));
    expect(heading()).toBe("Agent stopped");
    expect(renderer.root.findByType("button").props.children).toEqual(["unsent answer", " · conflict"]);

    update("b", 0);
    await act(() => renderer.update(<Screen {...({ theme } as PluginScreenProps)} />));
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    await press("Answer in place");
    expect(renderer.root.findByType("button").props.children[0]).toBe("edit answer");
  } finally {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
