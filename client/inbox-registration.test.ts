import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { expect, it, vi } from "vitest";
import contribute from "../index.client";
import { Decisions } from "./decisions";
import { SurfaceQuestions } from "./surface-questions";
import { useSurface } from "./use-surface";

vi.mock("react-native", () => ({}));
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
