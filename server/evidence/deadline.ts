/** A shared deadline: `guard` settles when the work does, or when time is up, whichever is first. */
export function makeDeadline(ms: number): { signal: AbortSignal; guard: <T>(work: Promise<T>) => Promise<T | typeof TIMED_OUT>; stop: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, ms);
  });
  return {
    signal: controller.signal,
    guard: (work) => Promise.race([work, expired]),
    stop: () => clearTimeout(timer),
  };
}
export const TIMED_OUT = Symbol("timed out");
