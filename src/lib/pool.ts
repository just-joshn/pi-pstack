import { errorMessage } from "./validation.ts";

export type PoolResult<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: string };

export async function pool<T, U>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<U>,
): Promise<PoolResult<U>[]> {
	if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw Error("Concurrency must be 1 to 8");
	const results: PoolResult<U>[] = [];
	const queue = items.entries();
	async function worker() {
		for (const [i, item] of queue) {
			try {
				results[i] = { status: "fulfilled", value: await fn(item, i) };
			} catch (error) {
				results[i] = { status: "rejected", reason: errorMessage(error) };
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, worker));
	return results;
}
