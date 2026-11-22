import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startSource } from "./client/source";
import { registerSurfaceTimeline } from "./client/surface-timeline";

export default function contribute(client: PluginClientContext) {
  const removeTimeline = registerSurfaceTimeline(client);
  const stopSource = startSource(client);
  return async () => {
    stopSource();
    await removeTimeline();
  };
}
