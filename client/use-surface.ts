import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useHosts } from "@getpaseo/plugin/client";
import { surfaceGet } from "../shared/rpc";
import type { SurfaceRecord } from "../shared/record";
import { callHost, getHub } from "./hub";
import { useSurfaceRevision } from "./use-docket";

/** Fetch one surface and keep it current across clients. */
export function useSurface(hostId: string, surfaceId: string) {
  const hub = getHub();
  const hosts = useHosts();
  const online = hosts.find((host) => host.serverId === hostId)?.status === "online";
  const source = useSyncExternalStore(hub.subscribe, () => hub.sourceFor(hostId));
  const revision = useSurfaceRevision(hostId, surfaceId);
  const removed = revision?.includes(":removed:");
  const key = JSON.stringify([hostId, surfaceId]);
  const [loaded, setLoaded] = useState<{ key: string; record: SurfaceRecord | null }>();
  const [failure, setFailure] = useState<string>();
  const refresh = useCallback(async () => {
    try {
      const record = await callHost(hub, hostId, surfaceGet, { surfaceId });
      // A call that started before a reconnect or deletion can finish afterwards.
      if (hub.sourceFor(hostId) !== source || hub.getSnapshot().get(hostId)?.revisions.get(surfaceId)?.startsWith("removed:")) return;
      setLoaded((prior) => prior?.key === key && prior.record && record && prior.record.rev > record.rev
        ? prior : { key, record });
      setFailure(undefined);
      return record;
    } catch {
      if (hub.sourceFor(hostId) === source) setFailure(key);
    }
  }, [hub, hostId, surfaceId, source, key]);

  useEffect(() => {
    if (online && source && !removed) void refresh();
  }, [online, source, removed, refresh, revision]);

  useEffect(() => {
    if (!online || !source || removed || failure !== key) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    function retry(delay: number) {
      timer = setTimeout(async () => {
        const result = await refresh();
        if (!stopped && result === undefined && delay < 4_000) retry(delay * 2);
      }, delay);
    }
    retry(1_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [online, source, removed, failure, key, refresh]);

  const unavailable = !online || !source || failure === key;
  const record = removed ? null : loaded?.key === key ? loaded.record : undefined;
  return { record, unavailable, refresh };
}
