import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { makeComponents } from "./client/components";
import { type Copy, getHub, snapshot } from "./client/hub";
import { BUNDLE_VERSION, ECHO_TOOL, MARKER, counterSubscription, reportRpc } from "./shared/contracts";

const NOTE_KIND = "docket-probe-note";

export default function contribute(client: PluginClientContext) {
  const hub = getHub();
  const copy: Copy = {
    copyId: Math.random().toString(36).slice(2, 10),
    bundleVersion: BUNDLE_VERSION,
    hostId: null,
    hostLabel: null,
    platform: null,
    startedAt: Date.now(),
    lastCounter: null,
    counters: 0,
    subscription: "none",
  };
  hub.copies.set(copy.copyId, copy);

  const report = (event: string, data: Record<string, unknown>) => {
    void client.rpc(reportRpc, { event, data: { copyId: copy.copyId, ...data } }).catch(() => undefined);
  };

  const cleanups: Array<() => void | Promise<void>> = [];
  const results: Record<string, string> = {};

  /** Registers one contribution point; a missing method or a throw is recorded, never rethrown. */
  const attempt = (name: string, method: string, register: () => unknown) => {
    const fn = (client as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      results[name] = `missing:${method}`;
      return;
    }
    try {
      const cleanup = register();
      if (typeof cleanup === "function") cleanups.push(cleanup as () => void);
      else if (cleanup && typeof (cleanup as { remove?: unknown }).remove === "function") {
        cleanups.push(() => (cleanup as { remove(): void }).remove());
      }
      results[name] = "ok";
    } catch (error) {
      results[name] = `threw:${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const ui = makeComponents(copy, hub, report);

  attempt("screen", "addScreen", () => client.addScreen({ id: "main", title: "Docket probe", Component: ui.Screen }));
  attempt("sidebarItem", "addSidebarHeaderItem", () =>
    client.addSidebarHeaderItem({ id: "main", title: "Docket probe", Component: ui.SidebarItem }),
  );
  attempt("sidebarView", "addSidebarView", () =>
    client.addSidebarView({ id: "main", title: "Docket probe", Component: ui.SidebarView }),
  );
  attempt("agentPanel", "addAgentPanel", () =>
    client.addAgentPanel({ id: "main", title: "Docket probe", icon: "LayoutGrid", Component: ui.AgentPanel }),
  );
  // A pill belongs to one workspace and agent; these placeholder ids register it but it is not visible.
  attempt("composerPill", "addComposerPill", () =>
    client.addComposerPill({
      id: "main",
      workspaceId: "docket-probe-placeholder",
      agentId: "docket-probe-placeholder",
      button: { title: "Docket probe", icon: "LayoutGrid", behavior: { kind: "action", onPress: () => undefined } },
    }),
  );
  attempt("timelineRenderer", "addTimelineRenderer", () =>
    client.addTimelineRenderer({
      kind: NOTE_KIND,
      version: 1,
      schema: z.object({ text: z.string() }),
      Component: ui.Renderer as never,
    }),
  );

  // P2: observe every tool_call item; report only ones for the echo tool or carrying the marker.
  // Every invocation is an observation; a replay after reopen/restart must show up, so nothing is de-duplicated.
  // Bound: up to MAX_OBSERVATIONS per callId; the next one writes a single explicit `tool_call.truncated` row.
  const MAX_OBSERVATIONS = 2000;
  const observations = new Map<string, number>();
  attempt("timelineTransformer", "addTimelineTransformer", () =>
    client.addTimelineTransformer({
      id: "tool-call-probe",
      query: { itemType: "tool_call" },
      transform({ item, phase }) {
        try {
          const detail = (item as { detail?: { type?: string; output?: unknown } }).detail;
          const output = detail?.output;
          const text = output === undefined ? "" : typeof output === "string" ? output : JSON.stringify(output);
          const hasMarker = text.includes(MARKER);
          const named = String(item.name).includes(ECHO_TOOL);
          if (!hasMarker && !named) return undefined;
          const n = (observations.get(item.callId) ?? 0) + 1;
          observations.set(item.callId, n);
          if (n > MAX_OBSERVATIONS + 1) return undefined;
          if (n === MAX_OBSERVATIONS + 1) {
            report("tool_call.truncated", { hostId: copy.hostId, callId: item.callId, observation: n, observedAt: Date.now(), cap: MAX_OBSERVATIONS });
            return undefined;
          }
          const input = (detail as { input?: { note?: unknown } } | undefined)?.input;
          const label = input && typeof input.note === "string" ? input.note : null;
          report("tool_call", {
            hostId: copy.hostId,
            callId: item.callId,
            observation: n,
            label,
            observedAt: Date.now(),
            name: item.name,
            status: item.status,
            phase,
            detailType: detail?.type ?? null,
            outputKind: output === undefined ? "undefined" : typeof output,
            hasMarker,
            outputSnippet: text.slice(0, 160),
          });
        } catch (error) {
          report("tool_call.error", { message: error instanceof Error ? error.message : String(error) });
        }
        return undefined;
      },
    }),
  );

  attempt("subscription", "subscribe", () => {
    const handle = client.subscribe(
      counterSubscription,
      { copyId: copy.copyId },
      (event) => {
        copy.lastCounter = event.seq;
        copy.counters += 1;
        report("counter", { hostId: copy.hostId, seq: event.seq, sentAt: event.sentAt, serverSubscribers: event.subscribers, latencyMs: Date.now() - event.sentAt });
      },
      {
        onClosed: ({ error }) => {
          copy.subscription = "closed";
          report("subscription.closed", { error: error?.message ?? null });
        },
      },
    );
    handle.ready.then(
      () => ((copy.subscription = "ready"), report("subscription.ready", {})),
      (error: unknown) => ((copy.subscription = "refused"), report("subscription.refused", { error: String(error) })),
    );
    return () => handle.release();
  });

  const clientKeys = Object.keys(client).sort();
  const badgeApis = clientKeys.filter((k) => /badge/i.test(k));
  results.workspaceRowBadge = badgeApis.length > 0 ? `present:${badgeApis.join(",")}` : "missing:no add*Badge method on client";

  report("start", {
    bundleVersion: BUNDLE_VERSION,
    userAgent: typeof navigator === "undefined" ? null : navigator.userAgent,
    results,
    clientKeys,
    ...snapshot(hub),
  });

  const heartbeat = setInterval(() => report("hub", { hostId: copy.hostId, ...snapshot(hub) }), 30000);
  cleanups.push(() => clearInterval(heartbeat));

  return () => {
    hub.copies.delete(copy.copyId);
    report("stop", { hostId: copy.hostId, ...snapshot(hub) });
    for (const fn of cleanups) {
      try {
        void fn();
      } catch {
        // ignore
      }
    }
  };
}
