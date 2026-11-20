// Fixture test: node scripts/summarize.check.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const out = JSON.parse(execFileSync("node", [join(dir, "summarize.mjs"), join(dir, "fixture.jsonl"), "--json"], { encoding: "utf8" }));
assert.equal(out.p2.length, 1, "aggregate groups the three same-shaped observations");
assert.equal(out.p2[0].count, 3);
assert.equal(out.p2Observations.length, 3, "every observation is listed");
assert.deepEqual(out.p2Observations.map((o) => [o.callId, o.observation, o.label, o.observedAt]), [
  ["call-A", 1, "Claude-after", 1000],
  ["call-A", 2, "Claude-after", 2000],
  ["call-B", 1, "Claude-plugin-reload", 3000],
]);
assert.equal(out.p2Observations[2].outputSnippet, "other snippet");
assert.equal(out.p2Truncated.length, 1);
const text = execFileSync("node", [join(dir, "summarize.mjs"), join(dir, "fixture.jsonl")], { encoding: "utf8" });
assert.match(text, /call=call-B #1 label=Claude-plugin-reload/);
assert.match(text, /TRUNCATED/);
console.log("summarize fixture check: ok");
