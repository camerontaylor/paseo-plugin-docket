import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SurfaceRecord } from "../shared/record";
import { revisionView, type ChangesText } from "../shared/revision-view";
import { evidenceGet } from "../shared/rpc";
import { callHost, getHub } from "./hub";
import { useSurface } from "./use-surface";

const empty: ChangesText = new Map();
const attemptTimeoutsMs = [4_000, 4_000, 8_000];
const retryDelaysMs = [250, 1_000];

function useFrozenChanges(hostId: string, record?: SurfaceRecord) {
  const surfaceId = record?.id;
  const snapshots = Object.entries(record?.snapshots ?? {})
    .flatMap(([id, snapshot]) => snapshot.kind === "changes" && typeof snapshot.block === "string" ? [[id, snapshot.block, snapshot.hash]] : []);
  const key = JSON.stringify([hostId, surfaceId, snapshots]);
  const hub = getHub();
  const source = useSyncExternalStore(hub.subscribe, () => hub.sourceFor(hostId));
  const [loaded, setLoaded] = useState<{ key: string; source: typeof source; changes: ChangesText; completed: number }>();
  useEffect(() => {
    if (!surfaceId || !source) return;
    const id = surfaceId;
    const [, , entries] = JSON.parse(key) as [string, string, [string, string, string][]];
    if (!entries.length) return;
    let active = true;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const isCurrent = () => active && hub.sourceFor(hostId) === source;
    const schedule = (run: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
      return timer;
    };
    const cancel = (timer: ReturnType<typeof setTimeout>) => {
      clearTimeout(timer);
      timers.delete(timer);
    };

    function read(snapshotId: string, block: string, attempt: number) {
      if (!isCurrent()) return;
      let settled = false;
      const deadline = schedule(() => finish(null), attemptTimeoutsMs[attempt]);
      function finish(text: string | null) {
        if (settled || !isCurrent()) return;
        settled = true;
        cancel(deadline);
        if (text === null) {
          const delay = retryDelaysMs[attempt];
          if (delay !== undefined) {
            schedule(() => read(snapshotId, block, attempt + 1), delay);
            return;
          }
        }
        setLoaded((prior) => {
          const previous = prior?.key === key && prior.source === source ? prior : undefined;
          const changes = text === null ? previous?.changes ?? empty : new Map(previous?.changes).set(block, text);
          return { key, source, changes, completed: (previous?.completed ?? 0) + 1 };
        });
      }
      void callHost(hub, hostId, evidenceGet, { surfaceId: id, snapshotId })
        .then(finish, () => finish(null));
    }

    for (const [id, block] of entries) read(id, block, 0);
    return () => {
      active = false;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [hostId, surfaceId, key, hub, source]);
  const current = loaded?.key === key && loaded.source === source ? loaded : undefined;
  return { changes: current?.changes ?? empty, pending: !!source && (current?.completed ?? 0) < snapshots.length };
}

export function useRevisionView(hostId: string, record: SurfaceRecord) {
  const history = useSurface(hostId, record.revises ?? undefined);
  const candidate = history.record;
  const earlier = candidate && candidate.id === record.revises && candidate.agentId === record.agentId ? candidate : undefined;
  const { changes: currentChanges, pending: currentPending } = useFrozenChanges(hostId, earlier && record);
  const { changes: earlierChanges, pending: earlierPending } = useFrozenChanges(hostId, earlier);
  const comparison = useMemo(
    () => earlier && revisionView(record, earlier, currentChanges, earlierChanges),
    [record, earlier, currentChanges, earlierChanges],
  );
  const loading = !history.unavailable && history.record === undefined;
  return { earlier, comparison, loading, evidencePending: currentPending || earlierPending };
}
