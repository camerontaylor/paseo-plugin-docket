#!/usr/bin/env node
// Summarises docket-probe report.jsonl. Usage: node summarize.mjs [path] [--json]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const path = args.find((a) => !a.startsWith("--")) ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "docket-probe", "report.jsonl");

const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const by = (k) => rows.reduce((m, r) => ((m[r[k]] ??= []).push(r), m), {});
const out = { file: path, rows: rows.length };

// P1: one entry per copy (copyId) with host, platform, hub, contribution results, counters, gaps.
const copies = {};
for (const r of rows.filter((r) => r.source === "client" && r.copyId)) {
  const c = (copies[r.copyId] ??= { copyId: r.copyId, daemonHost: r.daemonHost, hubs: new Set(), hostIds: new Set(), platforms: new Set(), bundles: new Set(), counters: [], events: {} });
  c.events[r.event] = (c.events[r.event] ?? 0) + 1;
  if (r.hubId) c.hubs.add(r.hubId);
  if (r.hostId) c.hostIds.add(r.hostId);
  if (r.platform) c.platforms.add(r.platform);
  if (r.bundleVersion) c.bundles.add(r.bundleVersion);
  if (r.event === "start") c.results = r.results;
  if (r.event === "counter") c.counters.push({ seq: r.seq, ts: r.ts });
  if (r.copies) c.lastHubCopies = r.copies.map((x) => `${x.copyId}@${x.hostId ?? "?"}`);
  if (["subscription.closed", "subscription.refused", "subscription.ready"].includes(r.event)) (c.subscriptionEvents ??= []).push(`${r.ts} ${r.event}${r.error ? " " + r.error : ""}`);
}
out.p1 = Object.values(copies).map((c) => {
  const seqs = c.counters.map((x) => x.seq);
  const gaps = seqs.slice(1).map((s, i) => s - seqs[i]).filter((d) => d !== 1).length;
  return { copyId: c.copyId, daemonHost: c.daemonHost, hubs: [...c.hubs], hostIds: [...c.hostIds], platforms: [...c.platforms], bundles: [...c.bundles], counterCount: seqs.length, firstSeq: seqs[0] ?? null, lastSeq: seqs.at(-1) ?? null, seqGapsOrResets: gaps, subscriptionEvents: c.subscriptionEvents ?? [], hubCopiesSeen: c.lastHubCopies ?? [], events: c.events, contributions: c.results ?? null };
});

// P2: tool calls reported by the transformer, grouped by provider-visible name/status/detail type.
const tools = rows.filter((r) => r.event === "tool_call");
const groups = {};
for (const t of tools) {
  const k = `${t.name} | ${t.status} | ${t.detailType} | marker=${t.hasMarker}`;
  (groups[k] ??= { count: 0, hosts: new Set(), phases: new Set(), sample: t.outputSnippet }).count++;
  groups[k].hosts.add(t.daemonHost);
  groups[k].phases.add(t.phase);
}
out.p2Observations = tools
  .map((t) => ({ ts: t.ts, observedAt: t.observedAt ?? null, daemonHost: t.daemonHost, copyId: t.copyId, hostId: t.hostId ?? null, callId: t.callId, observation: t.observation ?? null, label: t.label ?? null, name: t.name, status: t.status, phase: t.phase, detailType: t.detailType, hasMarker: t.hasMarker, outputSnippet: t.outputSnippet }))
  .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
out.p2Truncated = rows.filter((r) => r.event === "tool_call.truncated").map((r) => ({ ts: r.ts, callId: r.callId, cap: r.cap }));
out.p2 = Object.entries(groups).map(([k, g]) => ({ key: k, count: g.count, hosts: [...g.hosts], phases: [...g.phases], sample: g.sample }));
out.serverToolRuns = rows.filter((r) => r.event === "tool.start").map((r) => ({ ts: r.ts, daemonHost: r.daemonHost, agentId: r.agentId }));
out.serverStarts = rows.filter((r) => r.event === "server.start").map((r) => ({ ts: r.ts, daemonHost: r.daemonHost, pid: r.pid }));
out.sessionOpens = rows.filter((r) => r.event === "session_open").length;
out.errors = rows.filter((r) => /error|threw|refused/.test(r.event) || Object.values(r.results ?? {}).some((v) => String(v).startsWith("threw"))).length;

if (asJson) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`${out.file}: ${out.rows} rows, ${out.errors} error-ish`);
  console.log("\nP1 copies:");
  for (const c of out.p1) console.log(`  ${c.copyId} on ${c.daemonHost} hub=${c.hubs.join(",")} host=${c.hostIds.join(",") || "?"} platform=${c.platforms.join(",") || "?"} bundle=${c.bundles.join(",")} counters=${c.counterCount} (${c.firstSeq}..${c.lastSeq}, gaps ${c.seqGapsOrResets}) hub sees [${c.hubCopiesSeen.join(" ")}]\n    contributions: ${JSON.stringify(c.contributions)}\n    sub: ${c.subscriptionEvents.join("; ")}`);
  console.log("\nP2 observations (each transformer invocation reported, time order):");
  for (const o of out.p2Observations) console.log(`  ${o.ts} ${o.daemonHost} copy=${o.copyId} call=${o.callId} #${o.observation} label=${o.label ?? "-"} ${o.name} ${o.status}/${o.phase} ${o.detailType} marker=${o.hasMarker}`);
  for (const t of out.p2Truncated) console.log(`  TRUNCATED ${t.ts} call=${t.callId} after ${t.cap}`);
  console.log("\nP2 aggregates by name|status|detailType|marker:");
  for (const g of out.p2) console.log(`  ${g.key}  x${g.count} phases=${g.phases.join(",")}\n    sample: ${JSON.stringify(g.sample)}`);
  console.log(`\nserver starts: ${out.serverStarts.map((s) => `${s.daemonHost}@${s.ts}(pid ${s.pid})`).join(", ")}`);
  console.log(`server tool runs: ${out.serverToolRuns.length}, session_open rows: ${out.sessionOpens}`);
}
