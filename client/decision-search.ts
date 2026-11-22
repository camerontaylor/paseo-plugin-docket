const QUERY_DELAY_MS = 200;
const REFRESH_DELAY_MS = 1_000;

/** Run one query at a time and merge changes during each run into one follow-up. */
export function watchDecisionSearch<T>(
  subscribe: (listener: () => void) => () => void,
  search: () => Promise<T>,
  publish: (result: T) => void,
) {
  let stopped = false;
  let running = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(run, QUERY_DELAY_MS);

  async function run() {
    timer = undefined;
    running = true;
    dirty = false;
    try {
      const result = await search();
      if (!stopped) publish(result);
    } finally {
      running = false;
      if (!stopped && dirty) schedule();
    }
  }

  function schedule() {
    if (!running && timer === undefined) timer = setTimeout(run, REFRESH_DELAY_MS);
  }

  const unsubscribe = subscribe(() => {
    dirty = true;
    schedule();
  });

  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
}
