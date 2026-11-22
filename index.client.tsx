import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerAgentPanel } from "./client/agent-panel";
import { startSource } from "./client/source";
import { registerSurfaceTimeline } from "./client/surface-timeline";

export default function contribute(client: PluginClientContext) {
  const removePanel = registerAgentPanel(client);
  const removeTimeline = registerSurfaceTimeline(client);
  const stopSource = startSource(client);
  return async () => {
    stopSource();
    await Promise.all([removeTimeline(), removePanel()]);
  };
}
