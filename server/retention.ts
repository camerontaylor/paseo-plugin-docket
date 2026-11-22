import type { Store } from "./store";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Sweep on startup and schedule each run after the previous one settles. */
export function startRetention(getStore: () => Promise<Pick<Store, "compactDue">>) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function sweep() {
    try {
      const store = await getStore();
      if (!stopped) await store.compactDue();
    } catch {
      console.warn("[docket] retention sweep failed");
    }
    if (!stopped) {
      timer = setTimeout(() => { running = sweep(); }, SWEEP_INTERVAL_MS);
      timer.unref();
    }
  }
  let running = sweep();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
