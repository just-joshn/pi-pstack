import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { PoolResult } from "../lib/pool.ts";
import { readResult, sandbox, type ToolResponse } from "./host.ts";
import { shaped, spawned } from "./support.ts";

/** Runs Git in a directory and returns its output; fails the test when Git fails. */
export async function git(cwd: string, ...args: string[]) {
  const run = await spawned("git", args, { cwd });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}
export const commit = (cwd: string, message: string) =>
  git(
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    message,
  );
/** A new repository with one commit, inside the test sandbox. */
export async function repo() {
  const cwd = await mkdtemp(join(sandbox, "repo-"));
  await git(cwd, "init", "-q");
  await commit(cwd, "initial");
  return cwd;
}

export interface Audited {
  path: string;
  bare: boolean;
  prunable: boolean;
  merged: boolean | null;
  dirty: boolean | null;
  ignored: number | null;
}
export const created = (response: ToolResponse) =>
  shaped<{ path: string; base: string }>(readResult(response));
export const removed = (response: ToolResponse) =>
  shaped<{ removed: string }>(readResult(response)).removed;
/** The entries of a worktree audit that could be inspected. */
export const audits = (response: ToolResponse) =>
  shaped<PoolResult<Audited>[]>(readResult(response)).flatMap((entry) =>
    entry.status === "fulfilled" ? [entry.value] : [],
  );
/** The audit entry of one worktree. */
export const audited = (response: ToolResponse, path: string) =>
  audits(response).find((entry) => entry.path === path);
