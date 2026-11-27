import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { srcDir } from "../lib/catalog.ts";
import { isRecord } from "../lib/validation.ts";
import { type Job, readJob } from "./job-input.ts";

const git = promisify(execFile);

/**
 * Fetches `origin/<branch>` into a ref only this caller uses. Runs fetching the same repository at
 * once otherwise collide on the remote-tracking ref and FETCH_HEAD.
 */
export async function fetchBranch(repository: string, branch: string, ref: string, signal?: AbortSignal) {
	const refspec = `+refs/heads/${branch}:${ref}`;
	const args = ["fetch", "--quiet", "--no-write-fetch-head", "--refmap=", "origin", refspec];
	await git("git", ["-C", repository, ...args], { signal, killSignal: "SIGKILL" });
}
export const deleteRef = (repository: string, ref: string) => git("git", ["-C", repository, "update-ref", "-d", ref]);

export const sharedSkills = [
	"why",
	"tdd",
	"unslop",
	"principle-separate-before-serializing-shared-state",
	"principle-minimize-reader-load",
	"principle-guard-the-context-window",
	"principle-sequence-verifiable-units",
	"principle-fix-root-causes",
	"principle-prove-it-works",
];
const pack = ".pi/automations/benny";
const packSource = join(srcDir, "automations", "benny");
const packFiles = (await readdir(packSource, { recursive: true, withFileTypes: true }))
	.filter((entry) => entry.isFile())
	.map((entry) => [pack, ...relative(packSource, join(entry.parentPath, entry.name)).split(sep)].join("/"));

const quotedPath = /`(\.pi\/[^`\n]+)`|^[ \t]*(\.pi\/[^\n]*?)[ \t]*$/gm;
function namedPaths(text: string) {
	const quoted = [...text.matchAll(quotedPath)].map((m) => m[1] ?? m[2] ?? "");
	const prose = text.replace(quotedPath, "").match(/\.pi\/[\w./-]*\w/g) ?? [];
	return [...quoted, ...prose];
}
function requiredFiles(job: Job) {
	return [...new Set([".pi/settings.json", ...packFiles, ...namedPaths(job.instructions)])];
}

async function uncommittedFiles(repository: string, ref: string, files: string[]) {
	const args = ["-C", repository, "ls-tree", "-z", "--full-tree", ref, "--", ...files];
	const { stdout } = await git("git", args);
	const regularFiles = new Set(
		stdout
			.split("\0")
			.map((entry) => entry.match(/^100[67]\d\d blob \w+\t(.*)$/s)?.[1])
			.filter((path) => path !== undefined),
	);
	return files.filter((file) => !regularFiles.has(file));
}

function jsonLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

async function skillSources(
	piBin: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
	signal: AbortSignal | undefined,
) {
	const child = spawn(piBin, ["--mode", "rpc", "--no-session", "--approve", "--no-extensions"], {
		cwd,
		env,
		stdio: ["pipe", "pipe", "ignore"],
		...(signal && { signal, killSignal: "SIGKILL" as const }),
	});
	let failure: unknown;
	child.on("error", (error) => {
		failure = error;
	});
	child.stdin.on("error", () => {});
	const closed = new Promise((resolve) => child.once("close", resolve));
	const lines = createInterface({ input: child.stdout });
	const timer = setTimeout(() => {
		failure = Error(`${piBin} did not answer within ${timeoutMs} ms`);
		lines.close();
		child.stdout.destroy();
		child.kill("SIGKILL");
	}, timeoutMs);
	child.stdin.end(`${JSON.stringify({ id: "check", type: "get_commands" })}\n`);
	try {
		for await (const line of lines) {
			const response = jsonLine(line);
			if (!isRecord(response) || response["id"] !== "check") continue;
			const data = response["data"];
			const commands = isRecord(data) && Array.isArray(data["commands"]) ? data["commands"] : [];
			return new Map(
				commands.filter(isRecord).map((c) => {
					const info = isRecord(c["sourceInfo"]) ? c["sourceInfo"] : {};
					return [String(c["name"]), { scope: info["scope"], path: info["path"] }];
				}),
			);
		}
		if (failure) throw failure;
		return new Map<string, { scope: unknown; path: unknown }>();
	} finally {
		clearTimeout(timer);
		child.kill("SIGKILL");
		await closed;
	}
}

export async function projectSkills(
	cwd: string,
	piBin = process.env["PSTACK_PI_BIN"] ?? "pi",
	env: NodeJS.ProcessEnv = process.env,
	timeoutMs = 60_000,
	signal?: AbortSignal,
) {
	const sources = await skillSources(piBin, cwd, env, timeoutMs, signal);
	const files = new Map<string, string>();
	for (const skill of sharedSkills) {
		const source = sources.get(`skill:${skill}`);
		if (source?.scope === "project" && typeof source.path === "string") files.set(skill, source.path);
	}
	return { files, unresolved: sharedSkills.filter((s) => !files.has(s)) };
}

export async function checkJob(path: string, piBin = process.env["PSTACK_PI_BIN"] ?? "pi") {
	const job = await readJob(path, { draft: true });
	if (job.kind === "custom") throw Error("Only Benny jobs are checked");
	const branch = job.config.defaultBranch;
	const ref = `refs/pstack/check/${randomUUID()}`;
	await fetchBranch(job.cwd, branch, ref);
	const checkout = join(await mkdtemp(join(tmpdir(), "pstack-benny-check-")), "checkout");
	let added = false;
	try {
		const uncommitted = await uncommittedFiles(job.cwd, ref, requiredFiles(job));
		await git("git", ["-C", job.cwd, "worktree", "add", "--quiet", "--detach", checkout, ref]);
		added = true;
		const { unresolved } = await projectSkills(checkout, piBin);
		return {
			ok: !uncommitted.length && !unresolved.length,
			branch: `origin/${branch}`,
			uncommitted,
			unresolved,
		};
	} finally {
		if (added) await git("git", ["-C", job.cwd, "worktree", "remove", "--force", checkout]);
		await rm(join(checkout, ".."), { recursive: true, force: true });
		await deleteRef(job.cwd, ref);
	}
}
