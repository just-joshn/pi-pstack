import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { pool } from "./lib/pool.ts";
import { errorMessage, isRecord, parseJson } from "./lib/validation.ts";
import { artifacts, atomicWrite, fail, hasErrorCode, result, stringEnum } from "./support.ts";
import type { BusyPaths } from "./worktrees.ts";

export interface BackgroundJob {
	id: string;
	run: (signal: AbortSignal) => Promise<unknown>;
}

const statusFile = (dir: string, id: string) => join(dir, `${id}.status.json`);
const writeStatus = (dir: string, id: string, status: object) =>
	atomicWrite(statusFile(dir, id), JSON.stringify({ ...status, at: new Date().toISOString() }));

interface Worker {
	id: string;
	dir: string;
	controller: AbortController;
	fields: object;
	state: "admitting" | "queued" | "running";
	finished?: Promise<void>;
}

interface Registry {
	workers: Map<string, Worker>;
	closed: boolean;
}

function finish(registry: Registry, worker: Worker, status: object) {
	worker.finished ??= writeStatus(worker.dir, worker.id, { ...status, ...worker.fields }).finally(() => {
		registry.workers.delete(worker.id);
	});
	return worker.finished;
}

async function enqueue(registry: Registry, dir: string, ids: readonly string[], fields: object = {}) {
	if (registry.closed) fail("The worker session has shut down");
	if (new Set(ids).size !== ids.length || ids.some((id) => registry.workers.has(id)))
		fail("A worker with the same ID is already active");
	const queue: Worker[] = ids.map((id) => ({
		id,
		dir,
		controller: new AbortController(),
		fields,
		state: "admitting",
	}));
	for (const worker of queue) registry.workers.set(worker.id, worker);
	const writes = await Promise.allSettled(ids.map((id) => writeStatus(dir, id, { state: "queued" })));
	const failure = writes.find((write) => write.status === "rejected");
	if (failure || registry.closed) {
		const cleanup = await Promise.allSettled(
			queue.map((worker, i) => {
				worker.controller.abort();
				if (writes[i]?.status === "fulfilled") return finish(registry, worker, { state: "stopped" });
				registry.workers.delete(worker.id);
				return undefined;
			}),
		);
		const errors = [...writes, ...cleanup].flatMap((write) => (write.status === "rejected" ? [write.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length) throw new AggregateError(errors, "Could not queue workers");
	} else {
		for (const worker of queue) worker.state = "queued";
	}
	return queue;
}

async function runWorker<T>(registry: Registry, worker: Worker, run: () => Promise<T>) {
	let output: T;
	try {
		if (worker.controller.signal.aborted) fail(`Worker ${worker.id} was stopped before it started`);
		worker.state = "running";
		output = await run();
	} catch (error) {
		const state = worker.controller.signal.aborted ? "stopped" : "failed";
		await finish(registry, worker, { state, error: errorMessage(error) });
		throw error;
	}
	await finish(registry, worker, { state: "done" });
	return output;
}

async function startBackground(registry: Registry, dir: string, jobs: readonly BackgroundJob[], concurrency: number) {
	const queue = await enqueue(
		registry,
		dir,
		jobs.map((job) => job.id),
	);
	const byId = new Map(jobs.map((job) => [job.id, job]));
	const done = pool(queue, concurrency, (worker) =>
		runWorker(registry, worker, () => {
			const job = byId.get(worker.id);
			if (!job) fail(`Missing job for worker ${worker.id}`);
			return job.run(worker.controller.signal);
		}),
	);
	return { ids: jobs.map((job) => job.id), done };
}

interface ForegroundOptions {
	signal?: AbortSignal | undefined;
	fields?: object;
}

async function runForeground<T>(
	registry: Registry,
	dir: string,
	ids: readonly string[],
	concurrency: number,
	run: (id: string, stop: AbortSignal) => Promise<T>,
	options: ForegroundOptions,
) {
	const queue = await enqueue(registry, dir, ids, options.fields);
	const abortQueue = () => {
		for (const { controller } of queue) controller.abort();
	};
	if (options.signal?.aborted) abortQueue();
	else options.signal?.addEventListener("abort", abortQueue, { once: true });
	try {
		return await pool(queue, concurrency, (worker) =>
			runWorker(registry, worker, () => run(worker.id, worker.controller.signal)),
		);
	} finally {
		options.signal?.removeEventListener("abort", abortQueue);
	}
}

export function backgroundWorkers() {
	const registry: Registry = { workers: new Map(), closed: false };
	return {
		start: (dir: string, jobs: readonly BackgroundJob[], concurrency: number) =>
			startBackground(registry, dir, jobs, concurrency),
		foreground: <T>(
			dir: string,
			ids: readonly string[],
			concurrency: number,
			run: (id: string, stop: AbortSignal) => Promise<T>,
			options: ForegroundOptions = {},
		) => runForeground(registry, dir, ids, concurrency, run, options),
		state(id: string) {
			const state = registry.workers.get(id)?.state;
			return state === "admitting" ? undefined : state;
		},
		async stop(id: string) {
			const worker = registry.workers.get(id);
			if (!worker || worker.state === "admitting") fail(`No queued or running worker ${id} in this session`);
			worker.controller.abort();
			if (worker.state === "queued") await finish(registry, worker, { state: "stopped" });
		},
		async stopAll() {
			registry.closed = true;
			const queued: Promise<void>[] = [];
			for (const worker of registry.workers.values()) {
				worker.controller.abort();
				if (worker.state === "queued") queued.push(finish(registry, worker, { state: "stopped" }));
			}
			await Promise.all(queued);
		},
	};
}
export type BackgroundWorkers = ReturnType<typeof backgroundWorkers>;

async function entries(dir: string) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return [];
		throw error;
	}
}
async function lastActivity(dir: string) {
	const files = await entries(dir);
	const times = await Promise.all(
		files.filter((f) => f.isFile()).map(async (f) => (await stat(join(dir, f.name))).mtimeMs),
	);
	return times.length ? new Date(Math.max(...times)).toISOString() : null;
}
async function readJson(path: string) {
	try {
		const value: unknown = parseJson(await readFile(path, "utf8"), path);
		return isRecord(value) ? value : undefined;
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

export async function listWorkers(root: string, background: BackgroundWorkers, active: BusyPaths) {
	const batches = (await entries(root)).filter((e) => e.isDirectory());
	const found = await Promise.all(
		batches.map(async (batch) => {
			const dir = join(root, batch.name);
			const listed = await entries(dir);
			const ids = new Set([
				...listed.filter((e) => e.isDirectory() && e.name.startsWith("worker-")).map((e) => e.name),
				...listed.flatMap((e) => (e.name.endsWith(".status.json") ? [e.name.slice(0, -12)] : [])),
			]);
			return Promise.all(
				[...ids].map(async (id) => {
					const sessionDir = join(dir, id);
					const record = await readJson(join(sessionDir, "worker.json"));
					const status = await readJson(statusFile(dir, id));
					const saved = status?.["state"];
					const unsettled = saved === "queued" || saved === "running";
					const live = background.state(id) ?? (active.has(sessionDir) ? "running" : undefined);
					const state = live ?? (unsettled ? "interrupted" : (saved ?? "finished"));
					const { model, cwd, readOnly } = record ?? {};
					const error = status?.["error"];
					const activity = await lastActivity(sessionDir);
					const report = typeof status?.["report"] === "string" ? status["report"] : join(dir, `${id}.txt`);
					return {
						id,
						state,
						error,
						model,
						cwd,
						readOnly,
						sessionDir,
						report,
						lastActivity: activity,
					};
				}),
			);
		}),
	);
	return found.flat().toSorted((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}

export function registerBackground(pi: ExtensionAPI, background: BackgroundWorkers, active: BusyPaths) {
	pi.on("session_shutdown", () => background.stopAll());
	pi.registerTool({
		name: "pstack_workers",
		label: "Pstack workers",
		description:
			"List this session's pstack workers (state queued, running, done, failed, stopped, interrupted (its session closed first) or finished, with the error of a failed one; model; checkout; sessionDir; report; lastActivity, the newest write in its session), or stop a queued or running worker by id.",
		parameters: Type.Object({
			action: stringEnum(["list", "stop"]),
			id: Type.Optional(Type.String()),
		}),
		async execute(_id, p, _signal, _update, ctx) {
			if (p.action === "stop") await background.stop(p.id ?? "");
			return result(await listWorkers(join(artifacts(ctx), "workers"), background, active));
		},
	});
}
