import type { PluginClientContext } from "@getpaseo/plugin/client";
import { surfaces, surfacesList, type SurfaceEvent } from "../shared/rpc";
import { getHub, type Hub } from "./hub";

const MIN_DELAY = 1_000;
const MAX_DELAY = 60_000;
const SNAPSHOT_TIMEOUT = 10_000;

export function startSource(client: Pick<PluginClientContext, "rpc" | "subscribe">, hub: Hub = getHub()) {
  const source = { rpc: client.rpc.bind(client) };
  let hostId: string | undefined;
  let stopped = false;
  let delay = MIN_DELAY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeStream: (() => void) | undefined;

  function update(event: SurfaceEvent) {
    if (stopped || (hostId && hostId !== event.hostId)) return false;
    if (event.kind === "snapshot") {
      if (hostId && hub.sourceFor(hostId) !== source) return false;
      hostId = event.hostId;
    }
    if (hostId) hub.update(source, event);
    return true;
  }

  async function poll() {
    try {
      const { hostId: id, result } = await source.rpc(surfacesList, {});
      if (!update({ kind: "snapshot", hostId: id, summaries: result }) && !stopped && hostId) {
        hub.unavailable(hostId, source);
      }
    } catch {
      if (!stopped && hostId) hub.unavailable(hostId, source);
    }
    if (!stopped) openStream();
  }

  function openStream() {
    let handle: ReturnType<PluginClientContext["subscribe"]> | undefined;
    let closed = false;
    let receivedSnapshot = false;
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      if (handle) void handle.release().catch(() => undefined);
      if (stopped) return;
      if (receivedSnapshot && hostId) hub.unavailable(hostId, source);
      timer = setTimeout(() => { void poll(); }, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    }
    const deadline = setTimeout(close, SNAPSHOT_TIMEOUT);
    closeStream = close;
    try {
      handle = client.subscribe(surfaces, {}, (event) => {
        if (closed || (!receivedSnapshot && event.kind !== "snapshot")) return;
        if (!update(event)) return close();
        if (event.kind === "snapshot") {
          receivedSnapshot = true;
          clearTimeout(deadline);
          delay = MIN_DELAY;
        }
      }, { onClosed: close });
      void handle.ready.catch(close);
      if (closed) void handle.release().catch(() => undefined);
    } catch {
      close();
    }
  }

  openStream();
  return () => {
    stopped = true;
    clearTimeout(timer);
    closeStream?.();
    if (hostId) hub.unavailable(hostId, source, true);
  };
}
