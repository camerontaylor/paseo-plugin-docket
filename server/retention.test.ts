import { expect, it, vi } from "vitest";
import { startRetention } from "./retention";

it("sweeps at startup, retries after an error and drains an active sweep on stop", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const active = Promise.withResolvers<string[]>();
    const compactDue = vi.fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("store temporarily unavailable"))
      .mockReturnValueOnce(active.promise);
    const stop = startRetention(async () => ({ compactDue }));
    await vi.advanceTimersByTimeAsync(0);
    expect(compactDue).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(compactDue).toHaveBeenCalledTimes(2);
    const drained = vi.fn();
    const shutdown = stop().then(drained);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(drained).not.toHaveBeenCalled();

    active.resolve([]);
    await shutdown;
    expect(drained).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(compactDue).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    warn.mockRestore();
  }
});
