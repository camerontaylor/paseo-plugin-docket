import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Keyboard } from "react-native";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import type { Summary } from "../shared/projections";
import type { SurfaceRecord } from "../shared/record";
import { registerInbox } from "./inbox";
import { useDocketInbox } from "./use-docket";

vi.mock("react-native", () => ({
  Keyboard: { dismiss: vi.fn() }, View: "View", Text: "Text", ScrollView: "ScrollView", TextInput: "TextInput", Pressable: "Pressable",
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: () => null, useWorkspace: () => null, useAgents: () => [], useWorkspaces: () => [],
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({ WorkspaceRowBadge: undefined, Icon: undefined }));
vi.mock("./use-docket", () => ({ useDocketInbox: vi.fn() }));

it.each(["collapse", "filter"])("preserves unsaved and conflict state across section, tab and %s transitions", async (transition) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(Keyboard.dismiss).mockClear();
  const theme = { colors: {} } as PluginScreenProps["theme"];
  const summary: Summary = {
    id: "s_aaaaaa", rev: 1, agentId: "agent", workspaceId: null, summary: "Question",
    status: "open", createdAt: "2026-11-22T00:00:00Z", resolvedAt: null, openQuestions: 1,
    pendingDeliveries: 1, replacedBy: null, revises: null, compacted: false,
  };
  const host = (serverId: string, docketStatus: "ready" | "stale") => ({
    serverId, label: serverId, status: "online" as const, docketStatus,
    summaries: undefined, updatedAt: undefined,
  });
  function update(hostId: string, pendingDeliveries: number, docketStatus: "ready" | "stale" = "ready") {
    vi.mocked(useDocketInbox).mockReturnValue({
      sources: [host(hostId, docketStatus)], cards: [{ hostId, summary: { ...summary, pendingDeliveries } }],
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
  function Decisions() {
    const [query, setQuery] = useState("");
    return <input value={query} onChange={setQuery} />;
  }
  const addScreen = vi.fn<PluginClientContext["addScreen"]>(() => vi.fn());
  registerInbox({ addScreen, addSidebarHeaderItem: () => vi.fn() } as unknown as PluginClientContext, {
    useSurface: () => ({ record: { summary: "Question", compactedAt: null } as SurfaceRecord, unavailable: false, refresh }),
    SurfaceQuestions: Questions,
    Decisions,
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
    expect(heading()).toBe("Delivery");
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    await press("Answer");
    await act(() => renderer.root.findByType("button").props.onClick());

    update("a", 0);
    await act(() => renderer.update(<Screen {...({ theme } as PluginScreenProps)} />));
    expect(heading()).toBe("Waiting on you");
    expect(renderer.root.findByType("button").props.children).toEqual(["unsent answer", " · conflict"]);

    function expectPanes(activeIndex: number) {
      const panes = renderer.root.findAllByProps({ role: "tabpanel" });
      expect(panes).toHaveLength(2);
      panes.forEach(({ props }, index) => {
        const active = index === activeIndex;
        expect(props.style.display).toBe(active ? "flex" : "none");
        expect(props.accessibilityElementsHidden).toBe(!active);
        expect(props.importantForAccessibility).toBe(active ? "auto" : "no-hide-descendants");
        expect(props.pointerEvents).toBe(active ? "auto" : "none");
      });
    }
    expectPanes(0);
    await press("Decisions");
    expect(Keyboard.dismiss).toHaveBeenCalledTimes(1);
    expectPanes(1);
    expect(renderer.root.findByType("button").props.children).toEqual(["unsent answer", " · conflict"]);
    await act(() => renderer.root.findByType("input").props.onChange("saved search"));
    await press("Inbox");
    expectPanes(0);
    expect(renderer.root.findByType("button").props.children).toEqual(["unsent answer", " · conflict"]);
    await press("Decisions");
    expect(renderer.root.findByType("input").props.value).toBe("saved search");
    await press("Inbox");

    function expectDraftHidden() {
      let hidden = renderer.root.findByType("button").parent;
      while (hidden && hidden.props.style?.display !== "none") hidden = hidden.parent;
      expect(hidden?.props).toMatchObject({
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
        pointerEvents: "none",
      });
      expect(renderer.root.findByType("button").props.children).toEqual(["unsent answer", " · conflict"]);
    }
    if (transition === "collapse") {
      await press("Collapse");
      expectDraftHidden();
      await press("Answer");
    } else {
      const filter = renderer.root.findByProps({ accessibilityLabel: "Filter by agent label" });
      await act(() => filter.props.onChangeText("does not match"));
      expect(renderer.root.findAllByProps({ accessibilityRole: "header" })).toHaveLength(0);
      expectDraftHidden();
      await act(() => filter.props.onChangeText(""));
      expect(heading()).toBe("Waiting on you");
    }
    expect(renderer.root.findByType("button").props.children).toEqual(["unsent answer", " · conflict"]);

    update("a", 0, "stale");
    await act(() => renderer.update(<Screen {...({ theme } as PluginScreenProps)} />));
    expectDraftHidden();
    update("a", 0);
    await act(() => renderer.update(<Screen {...({ theme } as PluginScreenProps)} />));
    expect(renderer.root.findByType("button").props.children).toEqual(["unsent answer", " · conflict"]);

    update("b", 0);
    await act(() => renderer.update(<Screen {...({ theme } as PluginScreenProps)} />));
    expect(renderer.root.findAllByType("button")).toHaveLength(0);
    await press("Answer");
    expect(renderer.root.findByType("button").props.children[0]).toBe("edit answer");
  } finally {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["Back/reopen", "different history target"])("retains history answers across %s", async (transition) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const theme = { colors: {} } as PluginScreenProps["theme"];
  const target = (hostId: string) => ({ hostId, surfaceId: "s_aaaaaa" });
  const host = (serverId: string, docketStatus: "ready" | "stale" = "ready") => ({
    serverId, label: serverId, status: "online" as const, docketStatus,
    summaries: undefined, updatedAt: undefined,
  });
  let missing = false;
  const refresh = vi.fn();
  function Questions({ hostId }: { hostId: string }) {
    const [draft, setDraft] = useState("");
    const [conflict, setConflict] = useState(false);
    return <button id={hostId} onClick={() => { setDraft("unsent answer"); setConflict(true); }}>
      {draft || "edit answer"}{conflict && " · conflict"}
    </button>;
  }
  const addScreen = vi.fn<PluginClientContext["addScreen"]>(() => vi.fn());
  registerInbox({ addScreen, addSidebarHeaderItem: () => vi.fn() } as unknown as PluginClientContext, {
    useSurface: (hostId) => ({
      record: missing && hostId === "a" ? null : { summary: hostId, compactedAt: null } as SurfaceRecord,
      unavailable: false, refresh,
    }),
    SurfaceQuestions: Questions,
    Decisions: ({ openSurface }) => <ViewHistory openSurface={openSurface} />,
  });
  function ViewHistory({ openSurface }: { openSurface(next: ReturnType<typeof target>): void }) {
    return <>
      <button id="open-a" onClick={() => openSurface(target("a"))}>Open A</button>
      <button id="open-b" onClick={() => openSurface(target("b"))}>Open B</button>
    </>;
  }

  const Screen = addScreen.mock.calls[0][0].Component;
  const screen = () => <Screen {...({ theme } as PluginScreenProps)} />;
  function update(docketStatus: "ready" | "stale" = "ready") {
    vi.mocked(useDocketInbox).mockReturnValue({
      sources: [host("a", docketStatus), host("b")], cards: [], count: { kind: "exact", value: 0 },
    });
  }

  let renderer!: ReturnType<typeof create>;
  update();
  try {
    await act(() => { renderer = create(screen()); });
    const button = (id: string) => renderer.root.findAllByType("button").find((node) => node.props.id === id)!;
    const click = (id: string) => act(() => button(id).props.onClick());
    const draft = () => button("a").props.children;
    async function press(label: string) {
      const buttons = renderer.root.findAll((node) => node.type === "Pressable");
      const visible = buttons.find((node) => {
        if (node.findByType("Text").props.children !== label) return false;
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.props.style?.display === "none") return false;
        }
        return true;
      });
      expect(visible).toBeDefined();
      await act(() => visible!.props.onPress());
    }
    function expectHidden(id: string) {
      const retained = button(id);
      expect(retained).toBeDefined();
      let parent = retained.parent;
      while (parent && parent.props.style?.display !== "none") parent = parent.parent;
      expect(parent?.props).toMatchObject({ accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants", pointerEvents: "none" });
    }

    await press("Decisions");
    await click("open-a");
    await click("a");
    await press("Back to Decisions");
    if (transition === "different history target") {
      await click("open-b");
      expect(button("b").props.children[0]).toBe("edit answer");
      expectHidden("a");
      expect(draft()).toEqual(["unsent answer", " · conflict"]);
      await press("Back to Decisions");
    } else {
      expectHidden("a");
    }
    await click("open-a");
    expect(draft()).toEqual(["unsent answer", " · conflict"]);
    expectHidden("open-a");

    update("stale");
    await act(() => renderer.update(screen()));
    expectHidden("a");
    update();
    await act(() => renderer.update(screen()));
    expect(draft()).toEqual(["unsent answer", " · conflict"]);

    missing = true;
    await act(() => renderer.update(screen()));
    expect(button("a")).toBeUndefined();
    expect(renderer.root.findAll((node) => node.type === "Text"
      && node.props.children === "This surface is no longer available.")).toHaveLength(1);
    await press("Back to Decisions");
    missing = false;
    await act(() => renderer.update(screen()));
    expect(button("a")).toBeUndefined();
    await click("open-a");
    expect(draft()[0]).toBe("edit answer");
  } finally {
    await act(() => renderer?.unmount());
    vi.unstubAllGlobals();
  }
});
