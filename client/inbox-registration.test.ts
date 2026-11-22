import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { Children, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { SurfaceRecord } from "../shared/record";
import type { Summary } from "../shared/projections";
import { useDocketInbox } from "./use-docket";
import { expect, it, vi } from "vitest";
import contribute from "../index.client";
import { Decisions } from "./decisions";
import { SurfaceQuestions } from "./surface-questions";
import { useSurface } from "./use-surface";

vi.mock("react", async (load) => ({
  ...await load<typeof import("react")>(),
  useState: vi.fn(),
  useEffect: vi.fn(),
}));
vi.mock("react-native", () => ({ View: "View", Text: "Text", TextInput: "TextInput", ScrollView: "ScrollView" }));
vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: () => null, useWorkspace: () => null, useAgents: () => [], useWorkspaces: () => [],
}));
vi.mock("./use-docket", () => ({ useDocketInbox: vi.fn() }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ WorkspaceRowBadge: undefined }));
vi.mock("./agent-panel", () => ({ registerAgentPanel: vi.fn(() => vi.fn()) }));
vi.mock("./surface-timeline", () => ({ registerSurfaceTimeline: vi.fn(() => vi.fn()) }));
vi.mock("./source", () => ({ startSource: vi.fn(() => vi.fn()) }));
vi.mock("./decisions", () => ({ Decisions: vi.fn() }));
vi.mock("./surface-questions", () => ({ SurfaceQuestions: vi.fn() }));
vi.mock("./use-surface", () => ({ useSurface: vi.fn() }));

it.each([false, true])("registers and cleans up Inbox once, with badge support %s", async (badgeSupported) => {
  const removeScreen = vi.fn();
  const removeSidebar = vi.fn();
  const removeBadge = vi.fn();
  const addScreen = vi.fn<PluginClientContext["addScreen"]>(() => removeScreen);
  const addSidebarHeaderItem = vi.fn<PluginClientContext["addSidebarHeaderItem"]>(() => removeSidebar);
  const addWorkspaceRowBadgeItem = vi.fn(() => removeBadge);
  const client = {
    addScreen,
    addSidebarHeaderItem,
    ...(badgeSupported && { addWorkspaceRowBadgeItem }),
  } as unknown as PluginClientContext;

  const cleanup = contribute(client);
  expect(addScreen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "inbox" }));
  expect(addSidebarHeaderItem).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "inbox" }));
  expect(addWorkspaceRowBadgeItem).toHaveBeenCalledTimes(badgeSupported ? 1 : 0);

  const screen = addScreen.mock.calls[0][0].Component as (props: PluginScreenProps) => {
    props: { controls: unknown };
  };
  expect(screen({} as PluginScreenProps).props.controls).toEqual({ Decisions, SurfaceQuestions, useSurface });
  await cleanup();
  expect(removeScreen).toHaveBeenCalledTimes(1);
  expect(removeSidebar).toHaveBeenCalledTimes(1);
  expect(removeBadge).toHaveBeenCalledTimes(badgeSupported ? 1 : 0);
});

type Element = ReactElement<Record<string, unknown>>;
function find(tree: ReactNode, test: (element: Element) => boolean): Element | undefined {
  let match: Element | undefined;
  Children.forEach(tree, (child) => {
    if (match || !isValidElement<Record<string, unknown>>(child)) return;
    match = test(child) ? child : find(child.props.children as ReactNode, test);
  });
  return match;
}

function render(element: Element) {
  return (element.type as (props: Element["props"]) => Element)(element.props);
}

const theme = { colors: {} } as PluginScreenProps["theme"];
const summary: Summary = {
  id: "s_aaaaaa", rev: 1, agentId: "agent", workspaceId: "workspace", summary: "Question",
  status: "open", createdAt: "2026-11-22T00:00:00Z", resolvedAt: null, openQuestions: 1,
  pendingDeliveries: 0, replacedBy: null, revises: null, compacted: false,
};
function host(serverId: string, docketStatus: "ready" | "stale" = "ready") {
  return { serverId, label: serverId, status: "online" as const, docketStatus,
    summaries: undefined, updatedAt: undefined };
}

function queue(inbox: ReturnType<typeof useDocketInbox>) {
  const addScreen = vi.fn<PluginClientContext["addScreen"]>(() => vi.fn());
  contribute({ addScreen, addSidebarHeaderItem: () => vi.fn() } as unknown as PluginClientContext);
  const screen = addScreen.mock.calls[0][0].Component as (props: PluginScreenProps) => Element;
  vi.mocked(useDocketInbox).mockReturnValue(inbox);
  vi.mocked(useState).mockReset().mockReturnValueOnce(["inbox", vi.fn()]).mockReturnValueOnce([undefined, vi.fn()]);
  const tree = render(screen({ theme } as PluginScreenProps));
  expect(find(tree, (element) => element.props.accessibilityRole === "tablist")).toBeDefined();
  expect(find(tree, (element) => element.props.label === "Decisions")?.props.role).toBe("tab");
  return find(tree, (element) => element.props.inbox === inbox)!;
}

it("keeps expanded controls at the same keyed position across stale and reconnect", () => {
  const card = { hostId: "a", summary };
  const ready = host("a");
  const record = { summary: "Question", compactedAt: null } as SurfaceRecord;
  const refresh = vi.fn();
  const list = queue({ sources: [ready], cards: [card], count: { kind: "exact", value: 1 } });
  vi.mocked(useState).mockReturnValueOnce([undefined, vi.fn()]).mockReturnValueOnce([undefined, vi.fn()])
    .mockReturnValueOnce(["", vi.fn()]).mockReturnValueOnce([0, vi.fn()]);
  const row = find(render(list), (element) => element.props.card === card)!;

  function expandedFor(status: "ready" | "stale", unavailable = false, hostId = "a") {
    vi.mocked(useState).mockReturnValueOnce([true, vi.fn()]);
    vi.mocked(useSurface).mockReturnValue({ record, unavailable, refresh });
    const expanded = find(render({ ...row, props: { ...row.props, card: { ...card, hostId }, source: host(hostId, status) } }),
      (element) => element.props.surfaceId === summary.id)!;
    const wrapper = find(render(expanded), (element) => {
      const child = element.props.children as Element | undefined;
      return isValidElement(child) && child.type === SurfaceQuestions
        || Array.isArray(child) && child.some((item: Element) => item?.type === SurfaceQuestions);
    })!;
    return { expanded, wrapper, control: find(wrapper, (element) => element.type === SurfaceQuestions)! };
  }

  const first = expandedFor("ready");
  for (const next of [expandedFor("stale"), expandedFor("ready", true), expandedFor("ready")]) {
    expect([next.expanded.type, next.expanded.key]).toEqual([first.expanded.type, first.expanded.key]);
    expect([next.control.type, next.control.key]).toEqual([first.control.type, first.control.key]);
  }
  expect(expandedFor("stale").wrapper.props.style).toEqual({ display: "none" });
  expect(expandedFor("ready", true).wrapper.props.style).toEqual({ display: "none" });
  expect(expandedFor("ready").wrapper.props.style).not.toHaveProperty("display");
  expect(expandedFor("ready", false, "b").control.key).not.toBe(first.control.key);
});

it("restores remaining cards when the selected host and its workspace disappear", () => {
  const card = { hostId: "b", summary };
  const setHost = vi.fn();
  const setWorkspace = vi.fn();
  const list = queue({ sources: [host("b")], cards: [card], count: { kind: "exact", value: 1 } });
  vi.mocked(useState).mockReturnValueOnce(["a", setHost]).mockReturnValueOnce(['["a","workspace"]', setWorkspace])
    .mockReturnValueOnce(["", vi.fn()]).mockReturnValueOnce([0, vi.fn()]);
  vi.mocked(useEffect).mockClear();
  const tree = render(list);
  expect(find(tree, (element) => element.props.card === card)).toBeDefined();
  expect(find(tree, (element) => element.props.label === "All hosts")).toBeUndefined();
  vi.mocked(useEffect).mock.calls.at(-1)?.[0]();
  expect(setHost).toHaveBeenCalledWith(undefined);
  expect(setWorkspace).toHaveBeenCalledWith(undefined);
});
