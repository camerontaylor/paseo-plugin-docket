import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { noopTool } from "./server/noop-tool";

export default function contribute(server: PluginServerContext) {
  // S0 finding aid: record what the plugin process is given for PASEO_HOME (plan D8).
  const home = process.env.PASEO_HOME ?? null;
  const dir = path.join(home ?? path.join(os.homedir(), ".paseo"), "plugin-data", "docket");
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "s0-env.log"), `${new Date().toISOString()} PASEO_HOME=${home ?? "<unset>"} cwd=${process.cwd()}\n`);
  } catch {
    // The probe is best effort; the plugin must still load.
  }
  console.log(`[docket] loaded; PASEO_HOME=${home ?? "<unset>"}`);

  server.before("agent.session_open", ({ request }) => ({
    ...request,
    tools: [...request.tools, noopTool],
  }));

  return () => {};
}
