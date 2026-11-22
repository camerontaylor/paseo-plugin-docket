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

function fixture() {
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
  const snapshot = (patch: string) => JSON.stringify({
    files: [{ id: "f1", path: "a.ts", status: "changed", added: 1, removed: 0, patch }], notes: [],
  });
  return { earlier, current, snapshot };
}

it("retries failed and timed-out reads, ignores late results, and stops after three attempts", async () => {
  vi.useFakeTimers();
  let tree: ReturnType<typeof create> | undefined;
  try {
    callHost.mockReset();
    const { earlier, current, snapshot } = fixture();
    useSurface.mockReturnValue({ record: earlier.record });
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
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return snapshot("same");
    });
    let view!: ReturnType<typeof useRevisionView>;
    function Harness() {
      view = useRevisionView("owner", current.record);
      return null;
    }
    await act(() => { tree = create(createElement(Harness)); });
    expect(view.comparison?.incomplete).toBe(true);
    expect(view.evidencePending).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(250 + 4_000 + 1_000 + 5_000));
    expect(view.evidencePending).toBe(false);
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
    expect(view.evidencePending).toBe(false);
    expect(view.comparison?.incomplete).toBe(true);
  } finally {
    await act(() => tree?.unmount());
    vi.useRealTimers();
  }
});

it("ignores an in-flight read after the snapshot hash changes", async () => {
  callHost.mockReset();
  const { earlier, current, snapshot } = fixture();
  useSurface.mockReturnValue({ record: earlier.record });
  let finishOld!: (text: string) => void;
  callHost.mockImplementation(async (_hub, _host, _contract, { surfaceId }) => {
    if (surfaceId === current.record.id && !finishOld) {
      return new Promise<string>((resolve) => { finishOld = resolve; });
    }
    return snapshot("same");
  });
  let view!: ReturnType<typeof useRevisionView>;
  function Harness({ record }: { record: typeof current.record }) {
    view = useRevisionView("owner", record);
    return null;
  }
  let tree!: ReturnType<typeof create>;
  await act(() => { tree = create(createElement(Harness, { record: current.record })); });
  try {
    expect(view.evidencePending).toBe(true);
    const updated = { ...current.record, snapshots: { snap: { ...current.record.snapshots.snap, hash: "updated" } } };
    await act(() => tree.update(createElement(Harness, { record: updated })));
    expect(view.evidencePending).toBe(false);
    expect(view.comparison?.current.get("diff.f1")?.mark).toBe("Unchanged");
    await act(() => finishOld(snapshot("stale")));
    expect(view.comparison?.current.get("diff.f1")?.mark).toBe("Unchanged");
  } finally {
    await act(() => tree.unmount());
  }
});
