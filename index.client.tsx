import type { PluginClientContext } from "@getpaseo/plugin/client";
import { registerAgentPanel } from "./client/agent-panel";
import { Decisions } from "./client/decisions";
import { registerInbox } from "./client/inbox";
import { startSource } from "./client/source";
import { SurfaceQuestions } from "./client/surface-questions";
import { useSurface } from "./client/use-surface";
import { registerSurfaceTimeline } from "./client/surface-timeline";

export default function contribute(client: PluginClientContext) {
  const removePanel = registerAgentPanel(client);
  const removeTimeline = registerSurfaceTimeline(client);
  const removeInbox = registerInbox(client, { useSurface, SurfaceQuestions, Decisions });
  const stopSource = startSource(client);
  return async () => {
    stopSource();
    await Promise.all([removeInbox(), removeTimeline(), removePanel()]);
  };
}
