import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { writeReport } from "./server/report";
import {
  BUNDLE_VERSION,
  COUNTER_INTERVAL_MS,
  ECHO_TOOL,
  MARKER,
  counterSubscription,
  reportRpc,
} from "./shared/contracts";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** P2: returns a known marker line so a client transformer can check that the result text arrives unchanged. */
const echoTool = defineAgentTool({
  name: ECHO_TOOL,
  title: "Docket probe echo",
  description:
    "Probe tool. Returns a fixed marker line followed by the note you pass. Call it when asked; it has no other effect.",
  input: z.object({
    note: z.string().optional().describe("Any short text; echoed back"),
    delayMs: z
      .number()
      .int()
      .min(0)
      .max(30000)
      .optional()
      .describe("Wait this long before returning, so the call can be inspected while it runs"),
  }),
  async execute({ note, delayMs }, { agent, signal }) {
    await writeReport("server", "tool.start", { agentId: agent.id, note: note ?? null, delayMs: delayMs ?? 0 });
    if (delayMs) await sleep(delayMs, signal);
    await writeReport("server", "tool.end", { agentId: agent.id, aborted: signal.aborted });
    return { text: `${MARKER}\necho: ${note ?? ""}` };
  },
});

let tick = 0;

export default function contribute(server: PluginServerContext) {
  const subscribers = new Set<(seq: number) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;

  void writeReport("server", "server.start", {
    pid: process.pid,
    node: process.version,
    paseoHome: process.env.PASEO_HOME ?? null,
    serverKeys: Object.keys(server).sort(),
  });

  server.handle(counterSubscription, (input, { push, signal }) => {
    const send = (seq: number) =>
      void push({ seq, sentAt: Date.now(), subscribers: subscribers.size }).catch(() => undefined);
    subscribers.add(send);
    void writeReport("server", "subscribe.open", { copyId: input.copyId, subscribers: subscribers.size });
    timer ??= setInterval(() => {
      tick += 1;
      for (const fn of subscribers) fn(tick);
    }, COUNTER_INTERVAL_MS);
    signal.addEventListener(
      "abort",
      () => {
        subscribers.delete(send);
        void writeReport("server", "subscribe.close", { copyId: input.copyId, subscribers: subscribers.size });
        if (subscribers.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      },
      { once: true },
    );
  });

  server.handle(reportRpc, async ({ event, data }) => {
    await writeReport("client", event, data);
    return { ok: true };
  });

  server.before("agent.session_open", async ({ request }) => {
    await writeReport("server", "session_open", {
      agentId: (request as { agentId?: string }).agentId ?? null,
      provider: (request as { provider?: string }).provider ?? null,
      toolsBefore: request.tools.length,
    });
    return { ...request, tools: [...request.tools, echoTool] };
  });

  return () => {
    if (timer) clearInterval(timer);
    subscribers.clear();
    void writeReport("server", "server.stop", { bundle: BUNDLE_VERSION });
  };
}
