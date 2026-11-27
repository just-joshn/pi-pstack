import assert from "node:assert/strict";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { onTestFinished, test } from "vitest";

import { blindTranscript, readPaths } from "../src/lib/transcript.ts";
import { configFile, delegated, fulfilled, type HostOptions, host, model } from "./host.ts";
import { assumeShape, flag } from "./support.ts";

const firstText = (line: string) => assumeShape<{ content: { text: string }[] }>(JSON.parse(line)).content[0]?.text;

async function runArena(judges: string[], judgeCode: number) {
	onTestFinished(() => rm(configFile, { force: true }));
	const judge = "google/gemini";
	const h = host({
		confirm: true,
		execute: async (bin, args) => {
			if (bin === "git") return { code: 128, stdout: "", stderr: "not a repository" };
			if (flag(args, "--model") === judge && judgeCode)
				return { code: judgeCode, stdout: "", stderr: "judge offline" };
			const session = join(flag(args, "--session-dir") ?? "", "session.jsonl");
			await writeFile(
				session,
				JSON.stringify({
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "evidence" }] },
				}),
			);
			return { code: 0, stdout: "fixture report", stderr: "" };
		},
	});
	await h.cmd(
		"setup-pstack",
		JSON.stringify({
			roles: {
				"arena runners": ["auto", "inherit-parent"],
				"arena cross-judge pool": judges,
			},
		}),
	);
	h.ctx.scopedModels = [{ model: model("anthropic", "claude") }, { model: model("google", "gemini") }];
	return delegated(await h.call("pstack_delegate", { mode: "arena", tasks: ["review"], rubric: "evidence" }));
}

function judgingWorkers(judged: string[], prompts: string[] = []): NonNullable<HostOptions["execute"]> {
	return async (bin, args) => {
		if (bin === "git") return { code: 1, stdout: "", stderr: "not a repo" };
		const worker = flag(args, "--model") ?? "";
		const session = join(flag(args, "--session-dir") ?? "", "session.jsonl");
		const prompt = args.at(-1) ?? "";
		judged.push(worker);
		prompts.push(prompt);
		const content: object[] = [{ type: "text", text: `Compared work for ${worker}` }];
		const results: object[] = [];
		if (worker === "openai/gpt") {
			const paths = prompt.match(/\/[^\s,]+\/candidate-\d\.jsonl/g) ?? [];
			const projections = await Promise.all(paths.map((path) => readFile(path, "utf8")));
			assert(projections.every((line) => firstText(line)?.includes("[redacted-model]")));
			paths.forEach((path, i) => {
				content.push({ type: "toolCall", id: `r${i}`, name: "read", arguments: { path } });
				results.push(
					i === 0
						? { role: "toolResult", toolCallId: `r${i}`, content: [{ type: "text", text: "ok" }] }
						: { role: "toolResult", toolCallId: `r${i}`, isError: true, content: [] },
				);
			});
		}
		await writeFile(
			session,
			[{ role: "assistant", model: worker, content }, ...results]
				.map((message) => JSON.stringify({ type: "message", message }))
				.join("\n"),
		);
		return { code: 0, stdout: "review report", stderr: "" };
	};
}

const workerTranscript = [
	{ type: "session", id: "worker" },
	{
		type: "message",
		message: {
			role: "assistant",
			model: "claude",
			provider: "anthropic",
			content: [
				{ type: "text", text: "claude result" },
				{
					type: "toolCall",
					id: "ok",
					name: "read",
					arguments: { path: "/tmp/candidate.jsonl" },
				},
				{
					type: "toolCall",
					id: "denied",
					name: "read",
					arguments: { path: "/tmp/denied.jsonl" },
				},
				{
					type: "toolCall",
					id: "pending",
					name: "read",
					arguments: { path: "/tmp/lost.jsonl" },
				},
			],
		},
	},
	{
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "ok",
			toolName: "read",
			content: [{ type: "text", text: "actual artifact" }],
		},
	},
	{
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "denied",
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "Permission denied" }],
		},
	},
]
	.map((x) => JSON.stringify(x))
	.join("\n");

test("a failed arena judge returns the completed candidate reports", async () => {
	const { outputs, dir, judgment } = await runArena(["google/gemini"], 7);
	assert.equal(outputs.length, 2);
	await Promise.all(
		outputs.map(async (_, i) => {
			const report = fulfilled(outputs, i).report;
			assert.equal(dirname(report), dir);
			assert.equal(await readFile(report, "utf8"), "fixture report");
		}),
	);
	assert.match(judgment?.status ?? "", /inconclusive/i);
	assert.match(judgment?.error ?? "", /failed \(7\)/);
	const statuses = await Promise.all(
		(await readdir(dir)).filter((f) => f.endsWith(".status.json")).map((f) => readFile(join(dir, f), "utf8")),
	);
	const states = statuses.map((s) => assumeShape<{ state: string }>(JSON.parse(s)).state).toSorted();
	assert.deepEqual(states, ["done", "done", "failed"], "the judge's failure is recorded too");
});

test("judge selection skips both unavailable and same-vendor pool entries", async () => {
	const result = await runArena(["openai/gpt", "anthropic/claude", "google/gemini"], 0);
	assert.equal(result.judgment?.model, "google/gemini");
});

test("the judge may share a candidate's vendor, but never the parent's", async () => {
	onTestFinished(() => rm(configFile, { force: true }));
	const judged: string[] = [];
	const h = host({ confirm: true, execute: judgingWorkers(judged) });
	await h.cmd(
		"setup-pstack",
		JSON.stringify({
			roles: {
				"arena runners": ["anthropic/claude", "google/gemini"],
				"arena cross-judge pool": ["anthropic/claude", "google/gemini"],
			},
		}),
	);
	await h.call("pstack_delegate", { mode: "arena", tasks: ["compare"], rubric: "quality" });
	assert.equal(judged.at(-1), "google/gemini");
});

test("a candidate that drops out leaves the judge scoring the rest", async () => {
	onTestFinished(() => rm(configFile, { force: true }));
	const judged: string[] = [];
	const workers = judgingWorkers(judged);
	let calls = 0;
	const h = host({
		confirm: true,
		execute: async (bin, args, options) =>
			bin !== "git" && ++calls === 1 ? { code: 1, stdout: "", stderr: "crashed" } : workers(bin, args, options),
	});
	await h.cmd(
		"setup-pstack",
		JSON.stringify({
			roles: {
				"arena runners": ["auto", "inherit-parent"],
				"arena cross-judge pool": ["openai/gpt"],
			},
		}),
	);
	const output = delegated(
		await h.call("pstack_delegate", {
			mode: "arena",
			tasks: ["compare"],
			rubric: "quality",
			concurrency: 1,
		}),
	);
	assert.equal(judged.at(-1), "openai/gpt");
	assert.deepEqual(output.judgment?.dropouts, ["candidate-1"]);
	assert.deepEqual(
		output.judgment?.readAudit?.map((entry) => entry.path.split("/").at(-1)),
		["candidate-2.jsonl"],
	);
});

test("arena sends anonymous transcript files to the independent judge and reports missing reads", async () => {
	onTestFinished(() => rm(configFile, { force: true }));
	const judged: string[] = [];
	const prompts: string[] = [];
	const h = host({ confirm: true, execute: judgingWorkers(judged, prompts) });
	await h.cmd(
		"setup-pstack",
		JSON.stringify({
			roles: {
				"arena runners": ["anthropic/claude", "google/gemini"],
				"arena cross-judge pool": ["anthropic/claude", "openai/gpt"],
			},
		}),
	);
	const output = delegated(
		await h.call("pstack_delegate", {
			mode: "arena",
			tasks: ["shared task"],
			rubric: "secret rubric",
		}),
	);
	const [first = "", second = "", judge = ""] = prompts;
	for (const candidate of [first, second]) {
		assert(candidate.includes("shared task"));
		assert(!candidate.includes("secret rubric"), "candidates see only the task");
	}
	assert(judge.includes("secret rubric"), "the judge grades against the rubric");
	assert.equal(judged.at(-1), "openai/gpt");
	assert.deepEqual(
		output.outputs.map((_, i) => fulfilled(output.outputs, i).model),
		["anthropic/claude", "google/gemini"],
	);
	assert.deepEqual(
		output.judgment?.readAudit?.map((entry) => entry.read),
		[true, false],
	);
	assert.match(output.judgment.status, /INCONCLUSIVE/);
});

test("blinded transcript removes model metadata and read audit finds actual read call paths", () => {
	const raw = workerTranscript;
	const blind = blindTranscript(raw, "anthropic/claude");
	assert(!blind.includes("anthropic"));
	assert(!blind.includes("claude"));
	assert(blind.includes("actual artifact"));
	assert.deepEqual(readPaths(raw), ["/tmp/candidate.jsonl"]);
});
