/// <reference types="node" />
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { mcpExtensions, mcpTools } from "../lib/mcp-access.ts";
import { aliases } from "../lib/models.ts";
import { isRecord } from "../lib/validation.ts";
import { deleteRef, fetchBranch, projectSkills } from "./job-check.ts";
import { isMcp, planRun, readEvent, readJob } from "./job-input.ts";
import { piCommand } from "./pi-command.ts";

const srcDir = fileURLToPath(new URL("../", import.meta.url));

const [flag, jobFile, eventFile] = process.argv.slice(2);
if (flag !== "--run" || !jobFile)
	throw Error("Usage: node src/jobs/run-job.mjs --run <reviewed enabled job.json> [signed-event.json]");
const stopGraceMs = 5000;
/** @type {ReturnType<typeof spawn> | undefined} */
let child;
/** @type {NodeJS.Timeout | undefined} */
let forceStop;
const stopping = new AbortController();
const stop = () => {
	if (stopping.signal.aborted) return;
	stopping.abort();
	if (child && child.exitCode === null && child.signalCode === null) {
		const running = child;
		running.kill("SIGTERM");
		forceStop = setTimeout(() => running.kill("SIGKILL"), stopGraceMs).unref();
	}
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// On Windows, sending SIGTERM kills the runner instead of letting it write a receipt.
if (process.connected) {
	process.on("message", (message) => {
		if (isRecord(message) && message.type === "stop") stop();
	});
	process.channel?.unref();
}

const job = await readJob(jobFile);
const event = await readEvent(job, eventFile, process.env.PSTACK_EVENT_SECRET);
const benny = job.kind === "custom" ? undefined : job.config;
const repository = await realpath(job.cwd);
const jobPath = await realpath(jobFile);
const dir = join(dirname(jobPath), "runs");
await mkdir(dir, { recursive: true, mode: 0o700 });
const { prompt, key, eventId } = planRun(jobPath, job, event);
const runDir = join(dir, key);
if (stopping.signal.aborted) throw Error("Stopped before the run was claimed");
async function acknowledgeAdmission(message = { type: "admitted" }) {
	if (!process.send || !process.connected) return;
	await new Promise((resolve) => {
		process.send(message, () => resolve(undefined));
	});
}
async function syncDirectory(path) {
	// Windows does not support opening a directory with Node's file handles.
	if (process.platform === "win32") return;
	const folder = await open(path, "r");
	try {
		await folder.sync();
	} finally {
		await folder.close();
	}
}
try {
	await mkdir(runDir, { mode: 0o700 });
} catch (error) {
	if (!isRecord(error) || error.code !== "EEXIST" || !(await lstat(runDir)).isDirectory()) throw error;
	await syncDirectory(dir);
	let incomplete;
	try {
		const prior = JSON.parse(await readFile(join(runDir, "result.json"), "utf8"));
		incomplete = !isRecord(prior) || typeof prior.status !== "string" || !Number.isInteger(prior.code);
	} catch (failure) {
		if (!(failure instanceof SyntaxError) && (!isRecord(failure) || failure.code !== "ENOENT")) throw failure;
		incomplete = true;
	}
	// The prior runner may still be active or may have died after an external effect. Never replay it here.
	await acknowledgeAdmission({ type: "admitted", incomplete, runDir });
	await new Promise((resolve) => {
		process.stderr.write(
			`EEXIST: run already claimed${incomplete ? "; interrupted or unconfirmed" : ""}. Inspect ${runDir}\n`,
			resolve,
		);
	});
	process.exit(1);
}
const admission = await open(join(runDir, "admission.json"), "wx", 0o600);
try {
	await admission.writeFile(JSON.stringify({ eventId, runDir }, null, 2));
	await admission.sync();
} finally {
	await admission.close();
}
await syncDirectory(runDir);
await syncDirectory(dir);
await acknowledgeAdmission();
const cwd = benny ? join(runDir, "checkout") : repository;
const log = join(runDir, "stdout.txt");
const errorLog = join(runDir, "stderr.txt");
const piBin = process.env.PSTACK_PI_BIN ?? "pi";
const env = { ...process.env };
delete env.PSTACK_EVENT_SECRET;
delete env.PSTACK_SLACK_TRIGGER_TOKEN;

const mcp = job.tools.some(isMcp);
const args = [
	"--print",
	"--approve",
	"--no-extensions",
	...(mcp ? mcpExtensions.flatMap((extension) => ["-e", extension]) : ["--no-mcp"]),
	...(benny ? [] : ["--skill", join(srcDir, "skills")]),
	"--tools",
	[...new Set([...job.tools, ...(mcp ? mcpTools : [])])].join(","),
	"--session-dir",
	runDir,
];
if (job.tools.some((t) => t.startsWith("pstack_"))) args.push("-e", join(srcDir, "index.ts"));
if (job.model && !aliases.includes(job.model)) args.push("--model", job.model);
if (job.thinking) args.push("--thinking", job.thinking);

const git = promisify(execFile);
/** @param {string} branch */
async function checkout(branch) {
	const ref = `refs/pstack/runs/${key}`;
	await fetchBranch(repository, branch, ref, stopping.signal);
	try {
		const addWorktree = ["-C", repository, "worktree", "add", "--quiet", "--detach", cwd, ref];
		await git("git", addWorktree, { signal: stopping.signal, killSignal: "SIGKILL" });
	} finally {
		await deleteRef(repository, ref);
	}
}

const errorCode = (error) => (isRecord(error) && typeof error.code === "string" ? error.code : "unknown error");
/** @param {string} error */
const notStarted = (error) => ({ status: "not-started", code: 1, error });

/** @param {Map<string, string>} files */
function listSkillFilesInSystemPrompt(files) {
	// Pi leaves skills marked disable-model-invocation out of the model's skill list.
	const listed = [...files].map(([skill, file]) => `- ${skill}: ${file}`).join("\n");
	args.splice(
		args.indexOf("--tools"),
		0,
		"--append-system-prompt",
		`Your instructions name these pstack skills. Pi does not list them for you; read each one from its file when the instructions call for it:\n${listed}`,
	);
}

async function sharedSkillFilesOrFailure() {
	try {
		const { files, unresolved } = await projectSkills(cwd, piBin, env, 60_000, stopping.signal);
		return unresolved.length
			? notStarted(`pstack skills not in the checkout's project scope: ${unresolved.join(", ")}`)
			: files;
	} catch (error) {
		return notStarted(`Unable to start Pi (${errorCode(error)}); check PSTACK_PI_BIN`);
	}
}

async function prepareBennyRunOrFailure() {
	if (!benny) return undefined;
	try {
		await checkout(benny.defaultBranch);
	} catch {
		return notStarted(`Could not check out origin/${benny.defaultBranch} in ${repository}`);
	}
	const files = await sharedSkillFilesOrFailure();
	if (!(files instanceof Map)) return files;
	listSkillFilesInSystemPrompt(files);
	return undefined;
}

const launchFailure = (launched, reason) =>
	launched
		? {
				status: "unconfirmed",
				code: 1,
				error: `Pi run failed after launch (${reason}); inspect ${runDir}`,
			}
		: {
				status: "not-started",
				code: 1,
				error: `Unable to start Pi (${reason}); check PSTACK_PI_BIN`,
			};

async function runPi() {
	let out, err;
	try {
		out = await open(log, "wx", 0o600);
		err = await open(errorLog, "wx", 0o600);
		if (stopping.signal.aborted) return { status: "stopped", code: 1, error: "Stopped before Pi started" };
		child = spawn(...piCommand(piBin, args), {
			cwd,
			env,
			stdio: ["pipe", out.fd, err.fd],
		});
		const stdin = child.stdin;
		if (!stdin) throw Error("Pi started without a prompt stream");
		const exited = once(child, "exit");
		const sent = finished(stdin).then(
			() => true,
			() => false,
		);
		stdin.end(prompt);
		await exited;
		const code = child.exitCode ?? 1;
		const promptSent = code !== 0 || (await sent);
		if (stopping.signal.aborted) return { status: "stopped", code: code || 1 };
		if (!promptSent) return { status: "exited", code: 1, error: "Pi exited before receiving the job prompt" };
		return { status: "exited", code };
	} catch (error) {
		return launchFailure(child?.pid !== undefined, errorCode(error));
	} finally {
		clearTimeout(forceStop);
		await Promise.all([out?.close(), err?.close()]);
	}
}

const prepared = await prepareBennyRunOrFailure();
const outcome = stopping.signal.aborted
	? { status: "stopped", code: 1, error: "Stopped before Pi started" }
	: (prepared ?? (await runPi()));
await writeFile(join(runDir, "result.json"), JSON.stringify({ ...outcome, eventId, cwd, log, errorLog }, null, 2), {
	flag: "wx",
	mode: 0o600,
});
if (outcome.error) process.stderr.write(`${outcome.error}\n`);
process.stdout.write(`${JSON.stringify({ code: outcome.code, runDir, log })}\n`);
process.exitCode = outcome.code;
