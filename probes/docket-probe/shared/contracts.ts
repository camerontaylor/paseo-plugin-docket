import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** Bump on every edit so a stale copy shows up in the report as a different bundle version. */
export const BUNDLE_VERSION = "0.1.3";
export const PLUGIN_ID = "docket-probe";
export const ECHO_TOOL = "docket_probe_echo";
export const MARKER = "DOCKET_PROBE_MARKER ok 7f3a9c1e";
export const COUNTER_INTERVAL_MS = 5000;

/** A client copy hands one record to its own host's server; the server appends it to report.jsonl. */
export const reportRpc = defineRpc({
  name: "docket-probe.report",
  input: z.object({ event: z.string(), data: z.record(z.string(), z.unknown()) }),
  output: z.object({ ok: z.boolean() }),
});

/** The server pushes one tick to every subscriber; all subscribers of one daemon see the same values. */
export const counterSubscription = defineSubscription({
  name: "docket-probe.counter",
  input: z.object({ copyId: z.string() }),
  event: z.object({ seq: z.number(), sentAt: z.number(), subscribers: z.number() }),
});
