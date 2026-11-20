import { BUNDLE_VERSION } from "../shared/contracts";

/**
 * One hub per JS realm, kept on globalThis so every copy of the plugin evaluated in the same
 * realm (one per connected host) finds the others. Pattern from paseo-agent-tabs 0.2.5.
 */
export interface Copy {
  copyId: string;
  bundleVersion: string;
  /** Unknown at contribution time; learned from the first component that mounts (PluginHostProps.host). */
  hostId: string | null;
  hostLabel: string | null;
  platform: string | null;
  startedAt: number;
  lastCounter: number | null;
  counters: number;
  subscription: string;
}

export interface Hub {
  hubId: string;
  hubVersion: string;
  createdAt: number;
  copies: Map<string, Copy>;
}

const KEY = "__docketProbeHub";

export function getHub(): Hub {
  const g = globalThis as unknown as Record<string, Hub | undefined>;
  g[KEY] ??= {
    hubId: Math.random().toString(36).slice(2, 10),
    hubVersion: BUNDLE_VERSION,
    createdAt: Date.now(),
    copies: new Map(),
  };
  return g[KEY] as Hub;
}

export function snapshot(hub: Hub) {
  return {
    hubId: hub.hubId,
    hubVersion: hub.hubVersion,
    hubCreatedAt: hub.createdAt,
    copies: [...hub.copies.values()].map((c) => ({
      copyId: c.copyId,
      hostId: c.hostId,
      bundleVersion: c.bundleVersion,
      platform: c.platform,
      counters: c.counters,
    })),
  };
}
