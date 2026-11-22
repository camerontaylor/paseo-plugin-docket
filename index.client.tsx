import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerAgentPanel } from "./client/agent-panel";
import { startSource } from "./client/source";

export default function contribute(client: PluginClientContext) {
  const removePanel = registerAgentPanel(client);
  const stopSource = startSource(client);
  return () => {
    stopSource();
    return removePanel();
  };
}
