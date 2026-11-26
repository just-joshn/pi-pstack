import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { pool } from "./lib/pool.ts";
import { errorMessage, isRecord, parseJson } from "./lib/validation.ts";
import { artifacts, atomicWrite, fail, hasErrorCode, result, stringEnum } from "./support.ts";
import type { ActiveWorktrees } from "./worktrees.ts";

export interface BackgroundJob {
  id: string;
  run: (signal: AbortSignal) => Promise<unknown>;
}

const statusFile = (dir: string, id: string) => join(dir, `${id}.status.json`);
const writeStatus = (dir: string, id: string, status: object) =>
  atomicWrite(statusFile(dir, id), JSON.stringify({ ...status, at: new Date().toISOString() }));

export function backgroundWorkers() {
  const queued = new Map<string, AbortController>();
  const active = new Set<string>();
  function settle(dir: string, job: BackgroundJob, controller: AbortController) {
    active.add(job.id);
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
        queued.delete(job.id);
        active.delete(job.id);
        return writeStatus(dir, job.id, status);
      });
  }
  return {
    async start(dir: string, jobs: readonly BackgroundJob[], concurrency: number) {
      const queue = jobs.map((job) => ({ job, controller: new AbortController() }));
      for (const { job, controller } of queue) queued.set(job.id, controller);
      await Promise.all(jobs.map((job) => writeStatus(dir, job.id, { state: "queued" })));
      const done = pool(queue, concurrency, ({ job, controller }) => settle(dir, job, controller));
      return { ids: jobs.map((job) => job.id), done };
    },
    state: (id: string) => (active.has(id) ? "running" : queued.has(id) ? "queued" : undefined),
    stop(id: string) {
      const controller = queued.get(id);
      if (!controller) fail(`No running background worker ${id} in this session`);
      controller.abort();
    },
    stopAll() {
      for (const controller of queued.values()) controller.abort();
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

export async function listWorkers(
  root: string,
  background: BackgroundWorkers,
  active: ActiveWorktrees,
) {
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
          const report = join(dir, `${id}.txt`);
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
  return found
    .flat()
    .toSorted((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}

export function registerBackground(
  pi: ExtensionAPI,
  background: BackgroundWorkers,
  active: ActiveWorktrees,
) {
  pi.on("session_shutdown", () => background.stopAll());
  pi.registerTool({
    name: "pstack_workers",
    label: "Pstack workers",
    description:
      "List this session's pstack workers (state queued, running, done, failed, stopped, interrupted (its session closed first) or finished, with the error of a failed one; model; checkout; sessionDir; report; lastActivity, the newest write in its session), or stop a running background worker by id.",
    parameters: Type.Object({
      action: stringEnum(["list", "stop"]),
      id: Type.Optional(Type.String()),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      if (p.action === "stop") background.stop(p.id ?? "");
      return result(await listWorkers(join(artifacts(ctx), "workers"), background, active));
    },
  });
}
