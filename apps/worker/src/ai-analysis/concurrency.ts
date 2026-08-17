/**
 * Runs `task` once per item, at most `limit` concurrently — a small,
 * dependency-free worker-pool loop (no new npm package for this). Never
 * has more than `limit` calls in flight, regardless of `items.length`; see
 * `AI_AGENT_CONCURRENCY` in packages/shared/src/env.ts — this is what
 * enforces "never unlimited parallel OpenAI requests" for the six primary
 * agents.
 */
export async function mapWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await task(items[current] as T, current);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
