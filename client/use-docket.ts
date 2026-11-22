import { useSyncExternalStore } from "react";
import { useHosts } from "@getpaseo/plugin/client";
import { getHub, inboxOf } from "./hub";

export function useDocketInbox(confirmedMissing?: ReadonlySet<string>) {
  const hub = getHub();
  const snapshot = useSyncExternalStore(hub.subscribe, hub.getSnapshot);
  return inboxOf(snapshot, useHosts(), confirmedMissing);
}

/** Read beside a fetched surface and refetch whenever its observed revision changes. */
export function useSurfaceRevision(hostId: string, surfaceId: string) {
  const hub = getHub();
  const read = () => {
    const host = hub.getSnapshot().get(hostId);
    return host && `${host.snapshotNumber}:${host.revisions.get(surfaceId) ?? ""}`;
  };
  return useSyncExternalStore(hub.subscribe, read);
}
