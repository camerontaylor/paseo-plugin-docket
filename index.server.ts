import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { startDelivery } from "./server/delivery";
import type { PaseoApi } from "./server/delivery-host";
import { startRetention } from "./server/retention";
import { registerRpc } from "./server/rpc";
import { openStore } from "./server/store";
import { attachDocketTools, isDocketPermission, registerToolSettings } from "./server/tools";

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

  const settings = server.registerSettings(defineSettings({
    id: "delivery",
    scope: "host",
    version: 1,
    schema: z.object({ transport: z.enum(["auto", "direct"]).default("auto") }),
  }));
  const { readToolSettings, readRetentionDays } = registerToolSettings(server);
  let storePromise: ReturnType<typeof openStore> | undefined;
  function getStore() {
    return storePromise ??= readToolSettings()
      .then(({ recordEvents }) => openStore({ recordEvents }))
      .catch((error: unknown) => {
        storePromise = undefined;
        throw error;
      });
  }
  let delivery: Promise<ReturnType<typeof startDelivery>> | undefined;

  // The SDK supplies the host API in handler contexts. Start recovery as soon
  // as one is available, without blocking the session-open hook on host RPCs.
  function connect(paseo: PaseoApi) {
    return delivery ??= Promise.all([getStore(), settings.read()])
      .then(([store, config]) => startDelivery(store, paseo, {
        forceDirect: config.status === "ready" && config.values.transport === "direct",
      }))
      .catch((error: unknown) => {
        delivery = undefined;
        throw error;
      });
  }

  registerRpc(server, getStore, connect);

  const stopHooks = [
    server.before("agent.session_open", ({ request }, { paseo }) => {
      void connect(paseo).catch(() => console.warn("[docket] delivery startup failed"));
      return attachDocketTools(request, readToolSettings, getStore);
    }),
    server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
      if (request.kind !== "tool" || !isDocketPermission(request.name) || !(await readToolSettings()).allowToolPermissions) return;
      await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
    }),
    server.addHook("agent.turn.before", async ({ agent }, { paseo }) => (await connect(paseo)).check(agent.id)),
    server.addHook("agent.turn.after", async ({ agent }, { paseo }) => (await connect(paseo)).check(agent.id)),
    server.addHook("agent.permission.after", async ({ agent }, { paseo }) => (await connect(paseo)).check(agent.id)),
    server.addHook("agent.archive.after", async ({ agent }, { paseo }) => (await connect(paseo)).archive(agent.id)),
  ];
  const stopRetention = startRetention(getStore, readRetentionDays);
  return async () => {
    for (const stop of stopHooks) stop();
    await Promise.all([delivery?.then((worker) => worker.stop(), () => undefined), stopRetention()]);
  };
}
