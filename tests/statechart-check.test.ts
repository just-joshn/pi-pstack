import assert from "node:assert/strict";
import type * as childProcess from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test, vi } from "vitest";

import { check } from "../src/skills/statechart/scripts/run.ts";

const fixtures = fileURLToPath(new URL("./fixtures/statechart-check/", import.meta.url));

vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof childProcess>();
	return {
		...actual,
		spawn: (command: string, args: string[], options: childProcess.SpawnOptions) => {
			assert.equal(command, "fixture-java");
			return actual.spawn(process.execPath, [path.join(fixtures, "fake-java.mjs"), ...args], options);
		},
	};
});

// The transcripts and DOT were recorded from TLC 1.7.4 for Counter.tla and Counter.cfg.
test("checks a counter and marks the broken invariant on its graph", async () => {
	vi.stubEnv("JAVA", "fixture-java");
	vi.stubEnv("TLA2TOOLS", path.join(fixtures, "unused.jar"));
	const result = await check(path.join(fixtures, "Counter.tla"), path.join(fixtures, "Counter.cfg"));
	assert.equal(result.exit, 1);
	assert.deepEqual(
		result.rules.map(({ rule, outcome }) => ({ rule, outcome })),
		[{ rule: { kind: "invariant", name: "Safe" }, outcome: "broken" }],
	);
	assert.equal(result.states.initial, 1);
	assert.equal(result.states.distinct, 3);
	const states = [...result.graph.states.values()];
	assert.deepEqual(
		states.map((state) => state.vars.x),
		[0, 1, 2],
	);
	assert.equal(states[0]?.start, true);
	assert.deepEqual(states[2]?.breaks, [{ kind: "invariant", name: "Safe" }]);
	assert.deepEqual(
		result.graph.steps.map((step) => ({
			from: result.graph.states.get(step.from)?.vars.x,
			to: result.graph.states.get(step.to)?.vars.x,
			action: step.action,
		})),
		[
			{ from: 0, to: 1, action: "Next" },
			{ from: 1, to: 2, action: "Next" },
		],
	);
	assert.equal(result.paths, undefined);
});
