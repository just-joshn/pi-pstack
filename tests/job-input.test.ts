import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { test } from "vitest";

import { type Job, planRun, readEvent, readJob } from "../src/jobs/job-input.ts";
import { sandbox } from "./host.ts";

const secret = "test-secret";
const config = { sourceChannel: "C1", defaultBranch: "main" };
const custom = {
	version: 1,
	enabled: true,
	kind: "custom",
	cwd: "/tmp",
	tools: ["read"],
	instructions: "check",
};
const triage = { ...custom, kind: "benny-triage", tools: ["read", "mcp__slack__*"], config };
const report = { source_channel_id: "C1", message_ts: "1700000000.000100", thread_ts: "" };
const trigger = { ...report, ts: report.message_ts };

async function saved(value: unknown) {
	const dir = await mkdtemp(join(sandbox, "job-input-"));
	const path = join(dir, "file.json");
	await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
}
const job = async (value: unknown) => readJob(await saved(value));
const signed = (payload: unknown, key = secret) => {
	const text = JSON.stringify(payload);
	return { payload: text, signature: createHmac("sha256", key).update(text).digest("hex") };
};
const event = async (forJob: Job, envelope: unknown) => readEvent(forJob, await saved(envelope), secret);

test("a reviewed custom job is read with its explicit tools and model options", async () => {
	const read = await job({ ...custom, model: "openai/gpt", thinking: "max" });
	assert.equal(read.kind, "custom");
	assert.deepEqual(read.tools, ["read"]);
	assert.equal(read.thinking, "max");
	assert.equal(read.model, "openai/gpt");
});

test("a job without review, absolute cwd, instructions, tools or valid options is refused", async () => {
	const invalid = [
		null,
		[],
		{ ...custom, version: 2 },
		{ ...custom, enabled: false },
		{ ...custom, cwd: "relative" },
		{ ...custom, cwd: 1 },
		{ ...custom, kind: "unknown" },
		{ ...custom, instructions: "  " },
		{ ...custom, tools: [] },
		{ ...custom, tools: ["-bad"] },
		{ ...custom, tools: "read" },
		{ ...custom, model: "--flag" },
		{ ...custom, model: "" },
		{ ...custom, thinking: "extreme" },
		{ ...custom, thinking: 1 },
	];
	await Promise.all(invalid.map((value) => assert.rejects(job(value), /Job must be reviewed/, JSON.stringify(value))));
	await assert.rejects(job("{"), /Invalid JSON in job file/);
	assert.equal((await readJob(await saved({ ...custom, enabled: false }), { draft: true })).kind, "custom");
});

test("a Benny job names its source channel, default branch and Slack MCP tools", async () => {
	const incomplete = [
		undefined,
		{ ...config, sourceChannel: "" },
		{ ...config, defaultBranch: "" },
		{ ...config, defaultBranch: "-x" },
		{ ...config, defaultBranch: "a..b" },
		{ ...config, defaultBranch: 1 },
	];
	await Promise.all(
		incomplete.map((value) =>
			assert.rejects(job({ ...triage, config: value }), /source Slack channel and the repository/),
		),
	);
	await assert.rejects(job({ ...triage, tools: ["read", "bash"] }), /Slack MCP tools/);
	const read = await job({
		...triage,
		kind: "benny-repro",
		tools: ["bash", "edit", "mcp__slack__*"],
	});
	assert.deepEqual(read.kind === "custom" ? null : read.config, config);
});

test("a custom job needs no event, and a Benny job needs a path and a secret", async () => {
	assert.equal(await readEvent(await job(custom), undefined, undefined), null);
	const benny = await job(triage);
	await assert.rejects(readEvent(benny, undefined, secret), /authenticated event/);
	await assert.rejects(readEvent(benny, await saved(signed(report)), ""), /authenticated event/);
});

test("an event must be a well-formed envelope signed with the shared secret", async () => {
	const benny = await job(triage);
	const malformed = [
		null,
		{ payload: 1, signature: "a".repeat(64) },
		{ payload: "{}", signature: 1 },
		{ payload: "{}", signature: "short" },
	];
	await Promise.all(
		malformed.map((envelope) => assert.rejects(event(benny, envelope), /Invalid signed event envelope/)),
	);
	await assert.rejects(event(benny, signed(report, "other")), /signature rejected/);
	const signature = createHmac("sha256", secret).update("{").digest("hex");
	await assert.rejects(event(benny, { payload: "{", signature }), /Invalid JSON in signed event/);
});

test("a Benny event is upstream's trigger for a new top-level report in the source channel", async () => {
	const benny = await job(triage);
	const refused = [
		[],
		{ ...report, source_channel_id: "C2" },
		{ ...report, message_ts: "" },
		{ ...report, thread_ts: "1699999999.000001" },
	];
	await Promise.all(
		refused.map((payload) =>
			assert.rejects(event(benny, signed(payload)), /new top-level report/, JSON.stringify(payload)),
		),
	);
	assert.deepEqual(await event(benny, signed(report)), trigger);
	const { thread_ts: _, ...withoutThread } = report;
	assert.deepEqual(await event(benny, signed(withoutThread)), trigger);
	assert.deepEqual(await event(benny, signed({ ...report, thread_ts: report.message_ts, text: "private" })), {
		...trigger,
		thread_ts: report.message_ts,
	});
});

test("a custom event must be a signed JSON object", async () => {
	const own = await job(custom);
	await assert.rejects(readEvent(own, await saved(signed({})), undefined), /PSTACK_EVENT_SECRET/);
	await assert.rejects(event(own, signed([])), /must be a JSON object/);
	assert.deepEqual(await event(own, signed({ click: 1 })), { click: 1 });
});

test("a run's prompt and folder follow its job kind", async () => {
	const benny = await job({
		...triage,
		instructions: "channel {{SLACK_CHANNEL_ID}} at {{SLACK_MESSAGE_TS}}",
	});
	const first = planRun("/jobs/a.json", benny, trigger);
	assert(first.prompt.startsWith("channel C1 at 1700000000.000100\n\nTrigger:"));
	assert.equal(first.eventId, trigger.message_ts);
	assert.equal(planRun("/jobs/a.json", benny, trigger).key, first.key, "one run per report");
	assert.notEqual(planRun("/jobs/b.json", benny, trigger).key, first.key, "and per job");
	assert.notEqual(planRun("/jobs/a.json", benny, { ...trigger, message_ts: "2" }).key, first.key);
	const own = await job(custom);
	const click = planRun("/jobs/a.json", own, { eventId: "E1", note: "x" });
	assert.match(click.prompt, /^check\n\nAuthenticated event .*"note":"x"/);
	assert.equal(click.eventId, "E1");
	assert.notEqual(planRun("/jobs/a.json", own, { eventId: "E1" }).key, click.key, "each event gets its own run");
	const plain = planRun("/jobs/a.json", own, null);
	assert.equal(plain.prompt, "check");
	assert.equal(plain.eventId, undefined);
});

test("instructions that use only some trigger placeholders still get the whole trigger", async () => {
	const benny = await job({ ...triage, instructions: "Inspect reports in {{SLACK_CHANNEL_ID}}." });
	const { prompt } = planRun("/jobs/a.json", benny, trigger);
	assert(prompt.startsWith("Inspect reports in C1."));
	assert(prompt.includes(`"message_ts": "${trigger.message_ts}"`));
});
