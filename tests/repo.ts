import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import type { PoolResult } from "../src/lib/pool.ts";
import { readResult, sandbox, type ToolResponse } from "./host.ts";
import { assumeShape, spawned } from "./support.ts";

export async function git(cwd: string, ...args: string[]) {
	const run = await spawned("git", args, { cwd });
	assert.equal(run.status, 0, run.stderr);
	return run.stdout;
}
export const commit = (cwd: string, message: string) =>
	git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", message);
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
	activeWorker: boolean;
}
export const created = (response: ToolResponse) => assumeShape<{ path: string; base: string }>(readResult(response));
export const removed = (response: ToolResponse) => assumeShape<{ removed: string }>(readResult(response)).removed;
export const audits = (response: ToolResponse) =>
	assumeShape<PoolResult<Audited>[]>(readResult(response)).flatMap((entry) =>
		entry.status === "fulfilled" ? [entry.value] : [],
	);
export const audited = (response: ToolResponse, path: string) => audits(response).find((entry) => entry.path === path);
