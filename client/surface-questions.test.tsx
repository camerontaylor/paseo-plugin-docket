import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { createRecord } from "../shared/transitions";
import { SurfaceQuestions } from "./surface-questions";
import { useQuestionActions } from "./use-question-actions";

vi.mock("react-native", () => ({
  Pressable: "Pressable", Text: "Text", TextInput: "TextInput", View: "View",
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("@getpaseo/plugin/client", () => ({ useAgents: () => [], useAgent: () => null }));
vi.mock("./surface-blocks", () => ({
  SurfaceBlocks: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./use-revision-view", () => ({ useRevisionView: () => ({}) }));
vi.mock("./use-question-actions", () => ({ useQuestionActions: vi.fn() }));

it("lets a user copy or discard a refused compacted edit while showing the retained draft", async () => {
  const result = createRecord({
    id: "s_aaaaaa", agentId: "agent", now: "2026-11-21T10:00:00Z", document: { v: 1, summary: "Review" },
  });
  if (!result.ok) throw new Error(result.refusal.message);
  const target = "comment:plan.step";
  const resolveDraft = vi.fn();
  vi.mocked(useQuestionActions).mockReturnValue({
    comparison: [{ target, viewed: { comment: "Unsaved text" }, current: { version: 1, comment: "Retained text" }, cannotKeep: true }],
    pending: false, unsaved: true, resolveDraft,
  } as unknown as ReturnType<typeof useQuestionActions>);

  const element = createElement(SurfaceQuestions, {
    hostId: "host", theme: { colors: {} } as Parameters<typeof SurfaceQuestions>[0]["theme"],
    record: { ...result.record, document: null }, refresh: async () => undefined,
  });
  let tree!: ReturnType<typeof create>;
  await act(() => { tree = create(element); });
  const labels = tree.root.findAllByType("Text" as never);
  expect(labels.some((node) => node.children.join("") === "Keep my draft")).toBe(false);
  for (const draft of ["Unsaved text", "Retained text"]) {
    expect(labels.find((node) => node.children.join("") === `Comment: ${draft}`)?.props.selectable).toBe(true);
  }
  const discard = tree.root.findAllByType("Pressable" as never).find((button) =>
    button.findAllByType("Text" as never).some((node) => node.children.join("") === "Discard unsaved edit"));
  expect(discard).toBeDefined();
  await act(() => discard!.props.onPress());
  expect(resolveDraft).toHaveBeenCalledWith(target, false);
  await act(() => tree.unmount());
});
