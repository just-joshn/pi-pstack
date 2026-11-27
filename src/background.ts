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

interface Registry {
	queued: Map<string, { controller: AbortController; dir: string }>;
	active: Set<string>;
}

async function enqueue(registry: Registry, dir: string, ids: readonly string[]) {
	const queue = ids.map((id) => ({ id, controller: new AbortController() }));
	for (const { id, controller } of queue) registry.queued.set(id, { controller, dir });
	await Promise.all(ids.map((id) => writeStatus(dir, id, { state: "queued" })));
	return queue;
}

function settle(registry: Registry, dir: string, job: BackgroundJob, controller: AbortController) {
	registry.active.add(job.id);
	return job
		.run(controller.signal)
		.then(
			() => ({ state: "done" }),
			(error: unknown) => ({
				state: controller.signal.aborted ? "stopped" : "failed",
				error: errorMessage(error),
			}),
		)
		.then((status) => {
			registry.queued.delete(job.id);
			registry.active.delete(job.id);
			return writeStatus(dir, job.id, status);
		});
}

async function startBackground(registry: Registry, dir: string, jobs: readonly BackgroundJob[], concurrency: number) {
	const queue = await enqueue(
		registry,
		dir,
		jobs.map((job) => job.id),
	);
	const byId = new Map(jobs.map((job) => [job.id, job]));
	const done = pool(queue, concurrency, async ({ id, controller }) => {
		const job = byId.get(id);
		return controller.signal.aborted || !job ? undefined : settle(registry, dir, job, controller);
	});
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
	const queue = await enqueue(registry, dir, ids);
	const fields = options.fields ?? {};
	const abortQueue = () => {
		for (const { controller } of queue) controller.abort();
	};
	if (options.signal?.aborted) abortQueue();
	else options.signal?.addEventListener("abort", abortQueue, { once: true });
	try {
		return await pool(queue, concurrency, async ({ id, controller }) => {
			try {
				if (controller.signal.aborted) fail(`Worker ${id} was stopped before it started`);
				registry.active.add(id);
				const output = await run(id, controller.signal);
				await writeStatus(dir, id, { state: "done", ...fields });
				return output;
			} catch (error) {
				const state = controller.signal.aborted ? "stopped" : "failed";
				await writeStatus(dir, id, { state, error: errorMessage(error), ...fields });
				throw error;
			} finally {
				registry.active.delete(id);
				registry.queued.delete(id);
			}
		});
	} finally {
		options.signal?.removeEventListener("abort", abortQueue);
	}
}

export function backgroundWorkers() {
	const registry: Registry = { queued: new Map(), active: new Set() };
	const { queued, active } = registry;
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
		state: (id: string) => (active.has(id) ? "running" : queued.has(id) ? "queued" : undefined),
		async stop(id: string) {
			const entry = queued.get(id);
			if (!entry) fail(`No queued or running worker ${id} in this session`);
			entry.controller.abort();
			if (active.has(id)) return;
			queued.delete(id);
			await writeStatus(entry.dir, id, { state: "stopped" });
		},
		stopAll() {
			for (const { controller } of queued.values()) controller.abort();
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
