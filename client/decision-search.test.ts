import { expect, it, vi } from "vitest";
import { watchDecisionSearch } from "./decision-search";
import { createHub } from "./hub";

it("publishes searches and coalesces refreshes during sustained unrelated writes", async () => {
  vi.useFakeTimers();
  const hub = createHub();
  const source = { rpc: vi.fn() };
  hub.update(source, { kind: "snapshot", hostId: "host", summaries: [] });
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const search = vi.fn(() => second.promise).mockReturnValueOnce(first.promise);
  const publish = vi.fn();
  const stop = watchDecisionSearch(hub.subscribe, search, publish);

  async function churn(writes: number) {
    for (let rev = 1; rev <= writes; rev++) {
      hub.update(source, { kind: "change", hostId: "host", surfaceId: "s_aaaaaa", rev, summary: null });
      await vi.advanceTimersByTimeAsync(50);
    }
  }

  try {
    await churn(10);
    expect(search).toHaveBeenCalledTimes(1);
    first.resolve("query result");
    await churn(10);
    expect(publish).toHaveBeenCalledWith("query result");
    expect(search).toHaveBeenCalledTimes(1);
    await churn(20);
    expect(search).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);

    // A query or host change disposes the previous watcher.
    stop();
    second.resolve("obsolete refresh");
    await churn(30);
    expect(search).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    vi.useRealTimers();
  }
});
