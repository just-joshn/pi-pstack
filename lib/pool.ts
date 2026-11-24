export type PoolResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: string };

export async function pool<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<PoolResult<U>[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw Error("Concurrency must be 1 to 8");
  const results: PoolResult<U>[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One item at a time per worker.
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (error) {
        results[i] = {
          status: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, worker));
  return results;
}
