import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { createRecord } from "../shared/transitions";
import { evidenceGet } from "../shared/rpc";
import { useRevisionView } from "./use-revision-view";

const { callHost, useSurface, hub } = vi.hoisted(() => {
  const source = {};
  return { callHost: vi.fn(), useSurface: vi.fn(), hub: { subscribe: () => () => {}, sourceFor: () => source } };
});
vi.mock("./hub", () => ({ callHost, getHub: () => hub }));
vi.mock("./use-surface", () => ({ useSurface }));

it("retries failed and timed-out reads, ignores late results, and stops after three attempts", async () => {
  vi.useFakeTimers();
  let tree: ReturnType<typeof create> | undefined;
  try {
    const document = { v: 1 as const, summary: "Changes", view: { t: "changes" as const, id: "diff" } };
    const common = { agentId: "agent", now: "2026-11-21T10:00:00Z",
      changeItems: { diff: [{ id: "f1", title: "a.ts" }] },
      snapshots: { snap: { kind: "changes", block: "diff", hash: "hash", readAt: "now", bytes: 10 } },
    };
    const earlier = createRecord({ ...common, id: "s_aaaaaa", document });
    if (!earlier.ok) throw new Error(earlier.refusal.message);
    const current = createRecord({ ...common, id: "s_bbbbbb", revised: earlier.record,
      document: { ...document, revises: earlier.record.id } });
    if (!current.ok) throw new Error(current.refusal.message);
    useSurface.mockReturnValue({ record: earlier.record });
    const snapshot = (patch: string) => JSON.stringify({
      files: [{ id: "f1", path: "a.ts", status: "changed", added: 1, removed: 0, patch }], notes: [],
    });
    let late!: (text: string) => void;
    let attempts = 0;
    callHost.mockImplementation(async (_hub, host, contract, { surfaceId, snapshotId }) => {
      expect(host).toBe("owner");
      expect(contract).toBe(evidenceGet);
      expect(snapshotId).toBe("snap");
      if (surfaceId === current.record.id) return snapshot("same");
      expect(surfaceId).toBe(earlier.record.id);
      if (++attempts === 1) throw new Error("Temporary read failure");
      if (attempts === 2) return new Promise<string>((resolve) => { late = resolve; });
      return snapshot("same");
    });
    let view!: ReturnType<typeof useRevisionView>;
    function Harness() {
      view = useRevisionView("owner", current.record);
      return null;
    }
    await act(() => { tree = create(createElement(Harness)); });
    expect(view.comparison?.incomplete).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(250 + 4_000 + 1_000));
    expect(view.comparison?.current.get("diff.f1")?.mark).toBe("Unchanged");
    await act(() => late(snapshot("late and different")));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(view.comparison?.current.get("diff.f1")?.mark).toBe("Unchanged");
    expect(attempts).toBe(3);

    await act(() => tree!.unmount());
    callHost.mockRejectedValue(new Error("Unavailable"));
    callHost.mockClear();
    await act(() => { tree = create(createElement(Harness)); });
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(callHost).toHaveBeenCalledTimes(6);
    expect(view.comparison?.incomplete).toBe(true);
  } finally {
    await act(() => tree?.unmount());
    vi.useRealTimers();
  }
});
