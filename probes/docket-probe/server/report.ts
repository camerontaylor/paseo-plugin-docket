import { appendFile, mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { BUNDLE_VERSION, PLUGIN_ID } from "../shared/contracts";

export function reportDir(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", PLUGIN_ID);
}

export const reportPath = (): string => join(reportDir(), "report.jsonl");

let ready: Promise<unknown> | null = null;

/** One JSON object per line. Never throws: a probe must not break the daemon. */
export async function writeReport(
  source: "server" | "client",
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    ready ??= mkdir(reportDir(), { recursive: true });
    await ready;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      source,
      event,
      daemonHost: hostname(),
      serverBundle: BUNDLE_VERSION,
      ...data,
    });
    await appendFile(reportPath(), `${line}\n`);
  } catch {
    // Reporting is best effort.
  }
}
