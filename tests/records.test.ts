import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { test } from "vitest";

import { srcDir } from "../src/lib/catalog.ts";
import { host, resultText, sandbox } from "./host.ts";
import { assumeShape } from "./support.ts";

const decision = {
	phase: "plan",
	decision: "first",
	reason: "why",
	evidence: "proof",
	result: "ok",
};

test("an automation draft needs a known job kind and writes nothing without one", async () => {
	const h = host();
	await h.cmd("pstack-automation", "nightly");
	await h.cmd("pstack-automation");
	assert.deepEqual(h.notifications, Array(2).fill("Choose benny-triage, benny-repro, or custom."));
	await assert.rejects(() => readdir(h.artifacts), { code: "ENOENT" });
});

test("a custom automation draft asks for explicit instructions and carries no Benny configuration", async () => {
	const h = host();
	await h.cmd("pstack-automation", " custom ");
	const path = join(h.artifacts, "custom.job.json");
	const draft: unknown = JSON.parse(await readFile(path, "utf8"));
	assert.deepEqual(draft, {
		version: 1,
		enabled: false,
		kind: "custom",
		cwd: h.ctx.cwd,
		tools: [],
		instructions: "Supply explicit task, approved tools, trigger and finish predicate.",
	});
	assert.deepEqual(h.notifications, [`Disabled draft: ${path}. No job was enabled and no watcher was started.`]);
	assert.equal(h.executions.length, 0);
});

test("a second draft of the same kind does not overwrite the first", async () => {
	const h = host();
	await h.cmd("pstack-automation", "custom");
	const path = join(h.artifacts, "custom.job.json");
	const first = await readFile(path, "utf8");
	h.ctx.cwd = join(sandbox, "elsewhere");
	await assert.rejects(() => h.cmd("pstack-automation", "custom"), { code: "EEXIST" });
	assert.equal(await readFile(path, "utf8"), first);
});

test("later decisions are appended under the one header", async () => {
	const h = host();
	const path = resultText(await h.call("pstack_log", decision));
	const again = resultText(await h.call("pstack_log", { ...decision, decision: "second" }));
	assert.equal(again, path);
	assert.equal(path, join(h.artifacts, "decisions.tsv"));
	const [header, ...rows] = (await readFile(path, "utf8")).trimEnd().split("\n");
	assert.equal(header, "time\tphase\tdecision\treason\tevidence\tresult");
	assert.deepEqual(
		rows.map((row) => row.split("\t").slice(1)),
		[
			["plan", "first", "why", "proof", "ok"],
			["plan", "second", "why", "proof", "ok"],
		],
	);
});

test("the decision log escapes tabs into one TSV row", async () => {
	const h = host();
	const path = resultText(
		await h.call("pstack_log", {
			phase: "test",
			decision: "a\tb",
			reason: "why",
			evidence: "proof",
			result: "green",
		}),
	);
	assert((await readFile(path, "utf8")).includes("test\ta b\twhy\tproof\tgreen"));
});

test("a Benny draft is upstream's prompt template in a disabled job, and runs nothing", async () => {
	const h = host();
	await h.cmd("pstack-automation", "benny-repro");
	const draft = assumeShape<{
		enabled: boolean;
		name: string;
		instructions: string;
		tools: string[];
		config: { sourceChannel: string; defaultBranch: string };
	}>(JSON.parse(await readFile(join(h.artifacts, "benny-repro.job.json"), "utf8")));
	assert.equal(draft.enabled, false);
	assert.equal(draft.name, "benny-reproduce");
	assert.deepEqual(draft.config, { sourceChannel: "", defaultBranch: "" });
	assert(draft.tools.includes("edit") && draft.tools.includes("pstack_delegate"));
	const template = await readFile(join(srcDir, "automations/benny/templates/reproduce-automation-prompt.md"), "utf8");
	assert(
		draft.instructions.startsWith("Read and follow `.pi/automations/benny/skills/reproduce-and-fix-issues/SKILL.md`"),
	);
	assert(template.includes(draft.instructions));
	assert(draft.instructions.includes("{{SLACK_MESSAGE_TS}}"));
	assert.equal(h.executions.length, 0);
	await h.cmd("pstack-automation", "benny-triage");
	const triage = assumeShape<{ tools: string[] }>(
		JSON.parse(await readFile(join(h.artifacts, "benny-triage.job.json"), "utf8")),
	);
	assert(!triage.tools.includes("edit"));
});
