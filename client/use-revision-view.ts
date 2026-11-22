import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SurfaceRecord } from "../shared/record";
import { revisionView, type ChangesText } from "../shared/revision-view";
import { evidenceGet } from "../shared/rpc";
import { callHost, getHub } from "./hub";
import { useSurface } from "./use-surface";

const empty: ChangesText = new Map();

function useFrozenChanges(hostId: string, record?: SurfaceRecord) {
  const surfaceId = record?.id;
  const key = JSON.stringify([hostId, surfaceId, Object.entries(record?.snapshots ?? {})
    .flatMap(([id, snapshot]) => snapshot.kind === "changes" && typeof snapshot.block === "string" ? [[id, snapshot.block]] : [])]);
  const hub = getHub();
  const source = useSyncExternalStore(hub.subscribe, () => hub.sourceFor(hostId));
  const [loaded, setLoaded] = useState<{ key: string; changes: ChangesText }>();
  useEffect(() => {
    if (!surfaceId || !source) return;
    const [, , entries] = JSON.parse(key) as [string, string, [string, string][]];
    if (!entries.length) return;
    let active = true;
    void Promise.allSettled(entries.map(async ([snapshotId, block]) => {
      const text = await callHost(hub, hostId, evidenceGet, { surfaceId, snapshotId });
      return [block, text] as const;
    })).then((results) => {
      if (!active || hub.sourceFor(hostId) !== source) return;
      setLoaded({ key, changes: new Map(results.flatMap((result) =>
        result.status === "fulfilled" && result.value[1] !== null ? [[result.value[0], result.value[1]]] : [])) });
    });
    return () => { active = false; };
  }, [hostId, surfaceId, key, hub, source]);
  return loaded?.key === key ? loaded.changes : empty;
}

export function useRevisionView(hostId: string, record: SurfaceRecord) {
  const history = useSurface(hostId, record.revises ?? undefined);
  const candidate = history.record;
  const earlier = candidate && candidate.id === record.revises && candidate.agentId === record.agentId ? candidate : undefined;
  const currentChanges = useFrozenChanges(hostId, earlier && record);
  const earlierChanges = useFrozenChanges(hostId, earlier);
  const comparison = useMemo(
    () => earlier && revisionView(record, earlier, currentChanges, earlierChanges),
    [record, earlier, currentChanges, earlierChanges],
  );
  const loading = !history.unavailable && history.record === undefined;
  return { earlier, comparison, loading };
}
