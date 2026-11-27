import { createElement, useState, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { createRecord } from "../shared/transitions";
import { SurfaceQuestions } from "./surface-questions";
import { commentSet } from "../shared/rpc";

const callHost = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  Pressable: "Pressable", Text: "Text", TextInput: "TextInput", View: "View",
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("@getpaseo/plugin/client", () => ({ useAgents: () => [], useAgent: () => null }));
vi.mock("./surface-blocks", () => ({
  SurfaceBlocks: ({ children, record, feedback }: {
    children: ReactNode;
    record: { document: unknown };
    feedback: (block: string, item: string) => ReactNode;
  }) => <>{record.document && feedback("plan", "step")}{children}</>,
}));
vi.mock("./use-revision-view", () => ({ useRevisionView: () => ({}) }));
vi.mock("./hub", () => ({ callHost, getHub: () => null }));

it.each([true, false])("lets a user copy or discard a closed edit (refreshed record compacted: %s)", async (isCompacted) => {
  const result = createRecord({
    id: "s_aaaaaa", agentId: "agent", now: "2026-11-21T10:00:00Z", document: { v: 1, summary: "Review" },
  });
  if (!result.ok) throw new Error(result.refusal.message);
  callHost.mockClear();
  callHost.mockResolvedValue({ refusal: { code: "closed", message: "Surface compacted" } });
  const refreshed = { ...result.record, document: isCompacted ? null : result.record.document, comments: {
    "plan.step": { version: 2, text: "Retained text", title: "Plan step", delivery: null },
  } };
  function Harness() {
    const [record, setRecord] = useState(result.record);
    return <SurfaceQuestions hostId="host" theme={{ colors: {} } as Parameters<typeof SurfaceQuestions>[0]["theme"]}
      record={record} refresh={async () => { setRecord(refreshed); return refreshed; }} />;
  }
  let tree!: ReturnType<typeof create>;
  await act(() => { tree = create(createElement(Harness)); });
  const button = tree.root.findAllByType("Pressable" as never).find((node) =>
    node.findAllByType("Text" as never).some((text) => text.children.join("") === "Comment on this item"));
  await act(() => button!.props.onPress());
  vi.useFakeTimers();
  try {
    await act(() => tree.root.findByType("TextInput" as never).props.onChangeText("Unsaved text"));
    await act(() => vi.advanceTimersByTimeAsync(350));
  } finally {
    vi.useRealTimers();
  }
  expect(callHost).toHaveBeenCalledWith(null, "host", commentSet, {
    surfaceId: "s_aaaaaa", on: "plan.step", text: "Unsaved text", baseVersion: 0,
  });
  const labels = tree.root.findAllByType("Text" as never);
  expect(labels.some((node) => node.children.join("") === "Keep my draft")).toBe(false);
  for (const draft of ["Unsaved text", "Retained text"]) {
    expect(labels.find((node) => node.children.join("") === `Comment: ${draft}`)?.props.selectable).toBe(true);
  }
  const discard = tree.root.findAllByType("Pressable" as never).find((button) =>
    button.findAllByType("Text" as never).some((node) => node.children.join("") === "Discard unsaved edit"));
  expect(discard).toBeDefined();
  await act(() => discard!.props.onPress());
  expect(callHost).toHaveBeenCalledTimes(1);
  if (isCompacted) {
    expect(tree.root.findAllByType("Text" as never).some((node) => node.children.join("") === "Retained text")).toBe(true);
  } else {
    expect(tree.root.findByType("TextInput" as never).props.value).toBe("Retained text");
  }
  expect(tree.root.findAllByType("Text" as never).some((node) => node.children.join("") === "Comment: Unsaved text")).toBe(false);
  await act(() => tree.unmount());
});

it("describes a comment-only send in the send bar", async () => {
  const result = createRecord({
    id: "s_aaaaaa", agentId: "agent", now: "2026-11-21T10:00:00Z", document: { v: 1, summary: "Review" },
  });
  if (!result.ok) throw new Error(result.refusal.message);
  const record = { ...result.record, comments: {
    "plan.step": { version: 1, text: "Unsent note", title: "Plan step", delivery: null },
  } };
  let tree!: ReturnType<typeof create>;
  await act(() => {
    tree = create(<SurfaceQuestions hostId="host" theme={{ colors: {} } as Parameters<typeof SurfaceQuestions>[0]["theme"]}
      record={record} refresh={async () => record} />);
  });
  const texts = tree.root.findAllByType("Text" as never).map((node) => node.children.join(""));
  expect(texts).toContain("1 item comment");
  expect(texts).toContain("Send the item comment to the agent");
  expect(texts).not.toContain("Pick answers, then send");
  await act(() => tree.unmount());
});
