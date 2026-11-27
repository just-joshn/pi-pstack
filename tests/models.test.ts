import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { onTestFinished, test } from "vitest";

import type { RoleConfig } from "../src/lib/models.ts";
import {
	crossJudge,
	defaultConfig,
	effort,
	family,
	modelFor,
	parseModelConfig,
	selectPanel,
	validateConfig,
	vendor,
} from "../src/lib/models.ts";
import {
	configFile,
	delegated,
	fulfilled,
	type HostOptions,
	host,
	model,
	notARepository,
	type Run,
	swarm,
} from "./host.ts";
import { assumeShape, flag, nth } from "./support.ts";

const savedConfig = async () => assumeShape<RoleConfig>(JSON.parse(await readFile(configFile, "utf8")));
function modelTable(...models: string[]): Run {
	const rows = models.map((listed) => {
		const [provider = "", ...id] = listed.split("/");
		return [provider, id.join("/"), "1K"] as const;
	});
	const table = [["provider", "model", "context"] as const, ...rows];
	const width = (column: 0 | 1) => Math.max(...table.map((row) => row[column].length));
	const stdout = table
		.map(([provider, id, size]) => `${provider.padEnd(width(0))}  ${id.padEnd(width(1))}  ${size}`)
		.join("\n");
	return { code: 0, stderr: "", stdout };
}
const listsModels = (args: readonly string[]) => args.includes("--list-models");
const loadedBy = (args: readonly string[]) => args.filter((_, i) => args[i - 1] === "-e");
const unlisted: Record<string, HostOptions> = {
	"no loaded extension registers a command": { loadedExtensions: [] },
	"Pi lists the provider without the extension": {
		execute: async () => modelTable("anthropic/claude"),
	},
	"the extension lists only a longer model id": {
		execute: async (_, args) =>
			args.includes("-e") ? modelTable("anthropic/claude extra") : modelTable("google/gemini"),
	},
	"the extension's listing fails": {
		execute: async (_, args) => (args.includes("-e") ? { ...modelTable("anthropic/claude"), code: 1 } : modelTable()),
	},
};
const unknownScope: Record<string, Run> = {
	"exits with an error": { code: 1, stdout: "", stderr: "spawn pi ENOENT" },
	"is stopped before it answers": { code: 0, killed: true, stdout: "", stderr: "" },
};

test("model configuration validates available models and saves only after confirmation", async () => {
	onTestFinished(() => rm(configFile, { force: true }));
	const h = host({ confirm: false });
	const args = JSON.stringify({
		budget: "small",
		roles: { "arena cross-judge pool": ["google/gemini"] },
	});
	await h.cmd("setup-pstack", args);
	await assert.rejects(() => readFile(configFile));
	const yes = host({ confirm: true, extensionProviders: ["openai"] });
	await yes.cmd("setup-pstack", args);
	const config = await savedConfig();
	assert.equal(config.budget, "small");
	assert.deepEqual(config.roles["arena cross-judge pool"], ["google/gemini"]);
	await assert.rejects(() => yes.cmd("setup-pstack", JSON.stringify({ roles: { "bug-fix": ["invalid/model"] } })));
	await assert.rejects(
		() => yes.cmd("setup-pstack", JSON.stringify({ roles: { "bug-fix": ["openai/gpt"] } })),
		/Unavailable model for bug-fix/,
	);
});

test("interactive setup saves the selected budget and panel without changing the parent model", async () => {
	onTestFinished(() => rm(configFile, { force: true }));
	const h = host({ confirm: true, extensionProviders: ["openai"] });
	let panelSeats = 0;
	h.ctx.ui.select = async (label, choices) => {
		if (label === "Reasoning budget") return choices[1];
		if (choices.includes("Keep current")) {
			return label.startsWith("arena runners:") ? "Choose model(s)" : "Keep current";
		}
		assert(!choices.includes("openai/gpt"), "no loaded extension lists this model");
		return ["anthropic/claude", "google/gemini", "Done"][panelSeats++];
	};
	await h.cmd("setup-pstack");
	const config = await savedConfig();
	assert.equal(config.budget, "medium");
	assert.deepEqual(config.roles["arena runners"], ["anthropic/claude", "google/gemini"]);
	assert.deepEqual(h.ctx.model, { provider: "anthropic", id: "claude" });
});

test("model setup rejects malformed JSON shapes before saving", async () => {
	const h = host({ confirm: false });
	await Promise.all(
		[null, [], true, { roles: null }, { roles: [] }].map((value) =>
			assert.rejects(() => h.cmd("setup-pstack", JSON.stringify(value)), /Invalid model configuration/),
		),
	);
});

test("setup lists each worker model once, in sorted order", async () => {
	const h = host();
	h.ctx.modelRegistry.getAvailable = () => [
		model("openai", "gpt"),
		model("anthropic", "claude"),
		model("openai", "gpt"),
	];
	await h.cmd("setup-pstack", "show");
	assert.deepEqual(h.shown().available, ["anthropic/claude", "openai/gpt"]);
});

test("a worker loads only the extension that lists its model", async () => {
	const provider = "/extensions/provider.ts";
	const others = ["/extensions/before.ts", "/extensions/after.ts"];
	const workers: string[][] = [];
	const h = host({
		extensionProviders: ["anthropic"],
		loadedExtensions: [...others.slice(0, 1), provider, ...others.slice(1)],
		execute: async (bin, args) => {
			if (bin === "git") return notARepository;
			if (!listsModels(args)) {
				workers.push(args);
				return { code: 0, stdout: "worker report", stderr: "" };
			}
			assert(args.includes("--no-extensions") && !args.includes("--print"));
			const [extension, ...more] = loadedBy(args);
			assert.deepEqual(more, [], "a listing loads at most one extension");
			if (extension === provider) return modelTable("anthropic/claude", "google/gemini");
			if (extension !== undefined && others.includes(extension)) return modelTable("anthropic/other");
			assert.equal(extension, undefined, "only loaded extensions are listed");
			return modelTable("openai/gpt");
		},
	});
	await h.cmd("setup-pstack", "show");
	const shown = h.shown();
	assert.deepEqual(shown.available, ["anthropic/claude", "google/gemini", "openai/gpt"]);
	assert.equal(shown.warning, undefined);

	const provided = delegated(await h.call("pstack_delegate", swarm));
	assert.equal(fulfilled(provided.outputs).model, "anthropic/claude");
	assert.deepEqual(loadedBy(nth(workers, 0)), [provider]);
	assert(nth(workers, 0).includes("--no-extensions"));
	assert.equal(flag(nth(workers, 0), "--tools"), "read,grep,find,ls");

	h.ctx.model = model("google", "gemini");
	const builtIn = delegated(await h.call("pstack_delegate", { ...swarm, model: "inherit-parent" }));
	assert.equal(fulfilled(builtIn.outputs).model, "google/gemini");
	assert.deepEqual(loadedBy(nth(workers, 1)), []);
});

for (const [reason, options] of Object.entries(unlisted))
	test(`delegation refuses an extension model before spawning when ${reason}`, async () => {
		const h = host({
			extensionProviders: ["anthropic"],
			loadedExtensions: ["/extensions/provider.ts"],
			...options,
		});
		await h.cmd("setup-pstack", "show");
		const shown = h.shown();
		assert.deepEqual(shown.available, ["google/gemini", "openai/gpt"]);
		assert.match(shown.warning ?? "", /inherit-parent.*anthropic\/claude/);
		await assert.rejects(
			() => h.call("pstack_delegate", swarm),
			/Unavailable in the current worker scope: anthropic\/claude/,
		);
		assert(h.executions.every(([, args]) => listsModels(args)));
	});

for (const [failure, listing] of Object.entries(unknownScope))
	test(`nothing is offered or spawned when the listing without extensions ${failure}`, async () => {
		const h = host({
			extensionProviders: ["anthropic"],
			loadedExtensions: ["/extensions/provider.ts"],
			execute: async (_, args) => (args.includes("-e") ? modelTable("anthropic/claude", "google/gemini") : listing),
		});
		h.ctx.model = model("google", "gemini");
		await assert.rejects(() => h.cmd("setup-pstack", "show"), /could not list worker models/i);
		await assert.rejects(() => h.call("pstack_delegate", swarm), /could not list worker models/i);
		assert(h.executions.every(([, args]) => listsModels(args)));
	});

test("a model id with spaces and slashes keeps its extension", async () => {
	const wide = model("local ai", "org/big model");
	const workers: string[][] = [];
	const h = host({
		extensionProviders: [wide.provider],
		loadedExtensions: ["/extensions/provider.ts"],
		execute: async (bin, args) => {
			if (bin === "git") return notARepository;
			if (listsModels(args)) return args.includes("-e") ? modelTable("local ai/org/big model") : modelTable();
			workers.push(args);
			return { code: 0, stdout: "worker report", stderr: "" };
		},
	});
	h.ctx.model = wide;
	h.ctx.scopedModels = [{ model: wide }];
	const output = delegated(await h.call("pstack_delegate", swarm));
	assert.equal(fulfilled(output.outputs).model, "local ai/org/big model");
	assert.deepEqual(loadedBy(nth(workers, 0)), ["/extensions/provider.ts"]);
});

test("cancelling while worker models are listed reports the cancellation", async () => {
	const cancel = new AbortController();
	const h = host({
		extensionProviders: ["anthropic"],
		loadedExtensions: ["/extensions/provider.ts"],
		execute: async () => {
			cancel.abort();
			return { code: 143, killed: true, stdout: "", stderr: "" };
		},
	});
	await assert.rejects(() => h.call("pstack_delegate", swarm, cancel.signal), /Cancelled/);
});

test("roles, budget, alias and cross-vendor judge validation", () => {
	const cfg = defaultConfig();
	assert.equal(cfg.defaults, 3);
	assert.equal(cfg.budget, "large");
	assert.equal(Object.keys(cfg.roles).length, 9);
	validateConfig(cfg, []);
	const a = "anthropic/claude-sonnet",
		b = "google/gemini-pro",
		c = "openai/gpt-5";
	cfg.roles["arena runners"] = [a, b, c];
	cfg.roles["arena cross-judge pool"] = [a, b];
	validateConfig(cfg, [a, b, c]);
	assert.equal(modelFor("auto", a), a);
	assert.equal(modelFor("inherit-parent", a), a);
	assert.equal(crossJudge(cfg, a, new Set([a, b, c])), b);
	assert.equal(vendor("openrouter/anthropic/claude-sonnet"), "anthropic");
	assert.equal(vendor("openrouter/openai/gpt-5"), "openai");
	assert.equal(effort("feature, refactoring", "large"), "xhigh");
	assert.equal(effort("feature, refactoring", "medium"), "high");
	assert.equal(effort("feature, refactoring", "small"), "medium");
	assert.deepEqual(selectPanel(cfg, "arena runners", 4), [a, b, c, a]);
	assert.throws(() => validateConfig(cfg, [a]));
	cfg.roles["arena cross-judge pool"] = ["auto"];
	assert.throws(() => validateConfig(cfg, [a, b, c]));
	assert.throws(() => modelFor("auto", ""));
});

test("with no saved configuration, each role takes upstream's default from the models workers can use", () => {
	const exact = defaultConfig(["anthropic/claude-opus-5-5", "claude/claude-fable-5-2", "openai/gpt-6"]);
	assert.deepEqual(exact.roles["feature, refactoring"], ["anthropic/claude-opus-5-5"]);
	assert.deepEqual(exact.roles["swarm workers"], ["anthropic/claude-opus-5-5"]);
	assert.deepEqual(exact.roles["arena runners"], [
		"claude/claude-fable-5-2",
		"anthropic/claude-opus-5-5",
		"inherit-parent",
	]);
	assert.deepEqual(exact.roles["arena cross-judge pool"], ["anthropic/claude-opus-5-5"]);

	const sameFamily = defaultConfig(["a/claude-sonnet-5-5", "a/claude-opus-4-8", "g/gemini-3-pro"]);
	assert.deepEqual(sameFamily.roles["bug-fix"], ["a/claude-opus-4-8"]);
	assert.deepEqual(sameFamily.roles["interrogate reviewers"], [
		"inherit-parent",
		"a/claude-opus-4-8",
		"g/gemini-3-pro",
	]);
	assert.deepEqual(sameFamily.roles["arena cross-judge pool"], ["a/claude-opus-4-8", "g/gemini-3-pro"]);

	const none = defaultConfig(["openai/gpt-6"]);
	assert.deepEqual(none.roles["hillclimb"], ["inherit-parent"]);
	assert.deepEqual(none.roles["arena runners"], ["inherit-parent", "inherit-parent", "inherit-parent"]);
	assert.deepEqual(none.roles["arena cross-judge pool"], []);
});

test("model families follow arena's prefixes", () => {
	assert.equal(family("claude/claude-fable-5-2"), "claude-fable");
	assert.equal(family("anthropic/claude-opus-5-5"), "claude");
	assert.equal(family("google/gemini-4-neon"), "gemini");
	assert.equal(family("openai-codex/gpt-6.1-terra"), "gpt");
});

test("the file shape setup-pstack shows is one pstack_delegate accepts", async () => {
	const skill = await readFile(new URL("../src/skills/setup-pstack/SKILL.md", import.meta.url), "utf8");
	const example = /```\n(\{[\s\S]*?\n\})\n```/.exec(skill)?.[1];
	assert(example);
	const config = parseModelConfig(JSON.parse(example));
	assert.equal(config.budget, "large");
	assert.equal(config.roles["interrogate reviewers"].length, 3);
});

test("setup offers each verification skill the project lacks, then starts the one accepted", async () => {
	onTestFinished(() => rm(configFile, { force: true }));
	const asked: string[] = [];
	const h = host({
		confirm: (title) => {
			asked.push(title);
			return !title.startsWith("Want a formal");
		},
	});
	await mkdir(join(h.ctx.cwd, ".pi", "skills", "tla-checks"), { recursive: true });
	onTestFinished(() => rm(join(h.ctx.cwd, ".pi"), { recursive: true, force: true }));
	await h.cmd("setup-pstack", JSON.stringify({ budget: "medium" }));
	assert.deepEqual(asked.slice(1), [
		"Want a project-local verification skill, so agents can drive the app the way a user does and prove changes work?",
	]);
	assert.match(h.messages.at(-1) ?? "", /^Execute the Pi-native workflow create-verification-skill/);
});
