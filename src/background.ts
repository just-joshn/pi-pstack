import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { errorMessage, isRecord, parseJson } from "./lib/validation.ts";
import { artifacts, fail, hasErrorCode, result, stringEnum } from "./support.ts";

export interface BackgroundJob {
  id: string;
  run: (signal: AbortSignal) => Promise<unknown>;
}

export function backgroundWorkers() {
  const running = new Map<string, AbortController>();
  function settle(dir: string, job: BackgroundJob, controller: AbortController) {
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
        running.delete(job.id);
        const path = join(dir, `${job.id}.status.json`);
        return writeFile(path, JSON.stringify({ ...status, at: new Date().toISOString() }));
      });
  }
  return {
    start(dir: string, jobs: readonly BackgroundJob[]) {
      return jobs.map((job) => {
        const controller = new AbortController();
        running.set(job.id, controller);
        const settled = settle(dir, job, controller);
        return { id: job.id, settled };
      });
    },
    isRunning: (id: string) => running.has(id),
    stop(id: string) {
      const controller = running.get(id);
      if (!controller) fail(`No running background worker ${id} in this session`);
      controller.abort();
    },
    stopAll() {
      for (const controller of running.values()) controller.abort();
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

export async function listWorkers(root: string, background: BackgroundWorkers) {
  const batches = (await entries(root)).filter((e) => e.isDirectory());
  const found = await Promise.all(
    batches.map(async (batch) => {
      const dir = join(root, batch.name);
      const workers = (await entries(dir)).filter((e) => e.isDirectory());
      return Promise.all(
        workers.map(async ({ name: id }) => {
          const sessionDir = join(dir, id);
          const record = await readJson(join(sessionDir, "worker.json"));
          const status = await readJson(join(dir, `${id}.status.json`));
          const state = background.isRunning(id) ? "running" : (status?.["state"] ?? "finished");
          const { model, cwd, readOnly } = record ?? {};
          const activity = await lastActivity(sessionDir);
          const report = join(dir, `${id}.txt`);
          return { id, state, model, cwd, readOnly, sessionDir, report, lastActivity: activity };
        }),
      );
    }),
  );
  return found
    .flat()
    .toSorted((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}

export function registerBackground(pi: ExtensionAPI, background: BackgroundWorkers) {
  pi.on("session_shutdown", () => background.stopAll());
  pi.registerTool({
    name: "pstack_workers",
    label: "Pstack workers",
    description:
      "List this session's pstack workers (state running, done, failed, stopped or finished; model; checkout; sessionDir; report; lastActivity, the newest write in its session), or stop a running background worker by id.",
    parameters: Type.Object({
      action: stringEnum(["list", "stop"]),
      id: Type.Optional(Type.String()),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      if (p.action === "stop") background.stop(p.id ?? "");
      return result(await listWorkers(join(artifacts(ctx), "workers"), background));
    },
  });
}
