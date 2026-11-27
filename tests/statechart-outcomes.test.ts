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
			if (command !== "fixture-java") return actual.spawn(command, args, options);
			return actual.spawn(process.execPath, [path.join(fixtures, "fake-java.mjs"), ...args], options);
		},
	};
});

// Every scenario pairs a spec with a plan that replays recorded TLC output, so
// check() sees the same transcripts and exit codes that a real TLC run produces.
async function outcome(name: string, spec: string, config: string) {
	const folder = path.join(fixtures, "outcomes", name);
	vi.stubEnv("JAVA", "fixture-java");
	vi.stubEnv("TLA2TOOLS", path.join(fixtures, "unused.jar"));
	vi.stubEnv("STATECHART_FIXTURE", folder);
	return check(path.join(folder, spec), path.join(folder, config));
}

const verdicts = (rules: { rule: unknown; outcome: unknown }[]) =>
	rules.map(({ rule, outcome }) => ({ rule, outcome }));

test("holds every rule and draws the whole graph when TLC finds no error", async () => {
	const result = await outcome("counter-pass", "Counter.tla", "Counter.cfg");
	assert.equal(result.exit, 0);
	assert.equal(result.stop, undefined);
	assert.equal(result.drawing, undefined);
	assert.deepEqual(result.spec.variables, ["x"]);
	assert.deepEqual(verdicts(result.rules), [{ rule: { kind: "invariant", name: "Parity" }, outcome: "holds" }]);
	assert.deepEqual(result.states, { distinct: 3, initial: 1, complete: true, cut: false });
	assert.deepEqual(
		result.properties.map(({ rule, outcome, bug, initialOnly }) => ({ rule, outcome, bug, initialOnly })),
		[{ rule: { kind: "property", name: "NeverThree" }, outcome: "holds", bug: undefined, initialOnly: true }],
	);
	assert.equal(result.paths, undefined);
	const states = [...result.graph.states.values()];
	assert.deepEqual(
		states.map((state) => state.vars.x),
		[0, 1, 2],
	);
	assert.equal(states[0]?.start, true);
	assert.deepEqual(
		states.map((state) => state.breaks),
		[[], [], []],
	);
	assert.deepEqual(
		result.graph.steps.map((step) => step.action),
		["Next", "Next"],
	);
});

test("marks the terminal state a deadlock ends on", async () => {
	const result = await outcome("deadlock", "Counter.tla", "Counter.cfg");
	assert.equal(result.exit, 1);
	assert.equal(result.drawing, undefined);
	assert.deepEqual(verdicts(result.rules), [{ rule: { kind: "deadlock", name: "NoDeadlock" }, outcome: "broken" }]);
	const states = [...result.graph.states.values()];
	assert.deepEqual(
		states.map((state) => state.vars.x),
		[0, 1, 2],
	);
	// The dead-end pass marks the state with no outgoing step, and the trace
	// that ends there does not add the same rule twice.
	assert.deepEqual(states[2]?.breaks, [{ kind: "deadlock", name: "NoDeadlock" }]);
	assert.deepEqual(states[2]?.ends, [{ kind: "deadlock", name: "NoDeadlock" }]);
	assert.deepEqual(states[0]?.ends, undefined);
	assert.deepEqual(states[0]?.breaks, []);
	assert.deepEqual(states[1]?.breaks, []);
	assert.equal(result.paths, undefined);
});

test("names a broken state property and its lasso on the graph", async () => {
	const result = await outcome("latch/property", "../Latch.tla", "../Latch.cfg");
	assert.equal(result.exit, 1);
	assert.equal(result.stop, undefined);
	assert.deepEqual(result.rules, []);
	assert.deepEqual(result.states, { distinct: 2, initial: 1, complete: false, cut: false });
	assert.equal(result.paths, undefined);
	const x = (id: string | undefined) => (id === undefined ? undefined : result.graph.states.get(id)?.vars.x);
	const [property] = result.properties;
	assert.equal(property?.initialOnly, true);
	assert.equal(property?.outcome, "broken");
	assert.deepEqual(
		{
			start: x(property?.bug?.start),
			loop: property?.bug?.loop,
			stutters: property?.bug?.stutters,
			path: property?.bug?.path.map((step) => ({ action: step.action, to: x(step.state) })),
		},
		{ start: 0, loop: 1, stutters: true, path: [{ action: "Next", to: 1 }] },
	);
	assert.deepEqual(
		result.graph.steps.map((step) => ({ from: x(step.from), to: x(step.to), action: step.action })),
		[
			{ from: 0, to: 1, action: "Next" },
			{ from: 1, to: 1, action: "Next" },
		],
	);
});

test("reruns a temporal property violation and keeps the loop from the trace", async () => {
	const result = await outcome("latch/temporal", "../Latch.tla", "../Latch.cfg");
	assert.equal(result.exit, 1);
	assert.deepEqual(result.rules, []);
	// A temporal violation says nothing about the other rules, so TLC reruns
	// them; only the property run names what broke.
	assert.deepEqual(result.states, { distinct: 2, initial: 1, complete: true, cut: false });
	const x = (id: string | undefined) => (id === undefined ? undefined : result.graph.states.get(id)?.vars.x);
	const [property] = result.properties;
	assert.equal(property?.initialOnly, false);
	assert.equal(property?.outcome, "broken");
	assert.deepEqual(
		{
			start: x(property?.bug?.start),
			loop: property?.bug?.loop,
			stutters: property?.bug?.stutters,
			path: property?.bug?.path.map((step) => ({ action: step.action, to: x(step.state) })),
		},
		{
			start: 0,
			loop: 1,
			stutters: false,
			path: [
				{ action: "Next", to: 1 },
				{ action: "Next", to: 1 },
			],
		},
	);
	assert.equal(result.drawing, undefined);
});

test("cuts a bounded rerun and falls back to paths for a huge state space", async () => {
	const result = await outcome("multi", "Counter.tla", "Counter.cfg");
	assert.equal(result.exit, 1);
	assert.deepEqual(verdicts(result.rules), [
		{ rule: { kind: "invariant", name: "Safe" }, outcome: "broken" },
		{ rule: { kind: "invariant", name: "Second" }, outcome: "not checked" },
	]);
	assert.deepEqual(result.states, { distinct: 150_000, initial: 1, complete: false, cut: true });
	assert.equal(result.drawing, undefined);
	assert.deepEqual(result.properties, []);
	const states = [...result.graph.states.values()];
	assert.deepEqual(
		states.map((state) => state.vars.x),
		[0, 1, 2],
	);
	assert.deepEqual(states[2]?.breaks, [{ kind: "invariant", name: "Safe" }]);
	const [bug] = result.paths ?? [];
	assert.deepEqual(bug?.rule, { kind: "invariant", name: "Safe" });
	assert.deepEqual(
		bug?.path.map((step) => ({ action: step.action, to: result.graph.states.get(step.state)?.vars.x })),
		[
			{ action: "Next", to: 1 },
			{ action: "Next", to: 2 },
		],
	);
});

test("reports the SANY errors when the spec cannot be read", async () => {
	await assert.rejects(outcome("sany-failure", "Spec.tla", "Spec.cfg"), (error: Error) => {
		assert.match(error.message, /^SANY could not read .*Spec\.tla \(exit 1\):/);
		assert.match(error.message, /\*\*\* Errors: 1 error\(s\) detected\./);
		assert.match(error.message, /\.\.\. 6 more lines/);
		return true;
	});
});

test("reports the TLC error output when TLC fails to check the spec", async () => {
	await assert.rejects(outcome("tlc-error", "Spec.tla", "Spec.cfg"), (error: Error) => {
		assert.match(error.message, /^TLC could not check .*Spec\.tla \(exit 1\):/);
		assert.match(error.message, /Error: Invariant Safe is violated by the initial state\./);
		return true;
	});
});

test("refuses a failing TLC run that names no rule that broke", async () => {
	await assert.rejects(outcome("tlc-unnamed", "Spec.tla", "Spec.cfg"), (error: Error) => {
		assert.match(error.message, /^TLC exited 11 on .*Spec\.tla, but its output names no rule that broke:/);
		assert.match(error.message, /3 states generated, 3 distinct states found/);
		assert.match(error.message, /Warning: Please run the Java VM/);
		return true;
	});
});

test("reports the chart run when it leaves no graph dump", async () => {
	await assert.rejects(outcome("chart-missing", "Counter.tla", "Counter.cfg"), (error: Error) => {
		assert.match(error.message, /^TLC could not check .*Counter\.tla \(exit 0\):/);
		assert.match(error.message, /Model checking completed\. No error has been found\./);
		return true;
	});
});

test("matches a property that TLC reports as a broken initial invariant", async () => {
	const result = await outcome("latch/property-initial", "../Latch.tla", "../Latch.cfg");
	assert.equal(result.exit, 1);
	assert.deepEqual(result.rules, []);
	assert.deepEqual(result.states, { distinct: 2, initial: 1, complete: false, cut: false });
	const [property] = result.properties;
	assert.equal(property?.outcome, "broken");
	assert.equal(property?.initialOnly, true);
	const start = property?.bug?.start;
	assert.equal(start === undefined ? undefined : result.graph.states.get(start)?.vars.x, 0);
	assert.deepEqual(property?.bug?.path, []);
	assert.equal(property?.bug?.loop, undefined);
	assert.equal(property?.bug?.stutters, false);
});

test("splits a temporal violation into one run per property", async () => {
	const result = await outcome("temporal-group", "Multi.tla", "Multi.cfg");
	assert.equal(result.exit, 1);
	assert.deepEqual(verdicts(result.rules), [{ rule: { kind: "invariant", name: "Safe" }, outcome: "holds" }]);
	assert.deepEqual(result.states, { distinct: 3, initial: 1, complete: true, cut: false });
	assert.deepEqual(
		result.properties.map(({ rule, outcome, initialOnly }) => ({ rule, outcome, initialOnly })),
		[
			{ rule: { kind: "property", name: "First" }, outcome: "broken", initialOnly: false },
			{ rule: { kind: "property", name: "Second" }, outcome: "broken", initialOnly: false },
		],
	);
	const x = (id: string | undefined) => (id === undefined ? undefined : result.graph.states.get(id)?.vars.x);
	assert.deepEqual(
		result.properties.map((property) => property.bug?.path.map((step) => x(step.state))),
		[[1], [1, 2]],
	);
});

test("keeps every TLA+ value kind readable in a graph state", async () => {
	const result = await outcome("values", "Values.tla", "Values.cfg");
	assert.equal(result.exit, 1);
	assert.deepEqual(result.spec.variables, ["x", "ok", "color", "seen", "tags", "rec", "tup", "pairs", "range"]);
	assert.deepEqual(verdicts(result.rules), [{ rule: { kind: "invariant", name: "Types" }, outcome: "broken" }]);
	const [first, second] = [...result.graph.states.values()];
	assert.deepEqual(first?.vars, {
		x: 0,
		ok: true,
		color: "red",
		seen: { kind: "set", members: [1, 2] },
		tags: { kind: "set", members: ["a", "b"] },
		rec: { kind: "function", printedAs: "record", keys: ["a", "b"], values: [1, { kind: "set", members: [2] }] },
		tup: { kind: "function", printedAs: "tuple", keys: [1, 2], values: [1, "x"] },
		pairs: { kind: "function", printedAs: "pairs", keys: ["a", "b"], values: [1, 2] },
		range: { kind: "interval", lo: 1, hi: 3 },
	});
	assert.equal(first?.start, true);
	assert.deepEqual(first?.breaks, []);
	assert.equal(second?.vars.ok, false);
	assert.deepEqual(second?.vars.seen, { kind: "set", members: [1, 2, 3] });
	assert.deepEqual(second?.vars.range, { kind: "interval", lo: 0, hi: 3 });
	assert.deepEqual(second?.breaks, [{ kind: "invariant", name: "Types" }]);
	assert.deepEqual(second?.ends, [{ kind: "invariant", name: "Types" }]);
	// The counterexample matches the dumped state by value, so no extra state appears.
	assert.equal(result.graph.states.size, 2);
	assert.equal(result.paths, undefined);
	assert.deepEqual(
		result.graph.steps.map((step) => step.action),
		["Next"],
	);
});

test("says how to install TLC when mise is not on the path", async () => {
	const folder = path.join(fixtures, "outcomes", "counter-pass");
	vi.stubEnv("TLA2TOOLS", "");
	vi.stubEnv("PATH", path.join(fixtures, "no-such-bin"));
	await assert.rejects(check(path.join(folder, "Counter.tla"), path.join(folder, "Counter.cfg")), (error: Error) => {
		assert.match(error.message, /^Cannot find TLC: mise install failed:/);
		assert.match(error.message, /Or set TLA2TOOLS to the path of tla2tools\.jar/);
		return true;
	});
});

test("reports the spawn error when the java command is missing", async () => {
	const folder = path.join(fixtures, "outcomes", "counter-pass");
	vi.stubEnv("JAVA", "statechart-missing-java");
	vi.stubEnv("TLA2TOOLS", path.join(fixtures, "unused.jar"));
	await assert.rejects(check(path.join(folder, "Counter.tla"), path.join(folder, "Counter.cfg")), (error: Error) => {
		assert.match(error.message, /^SANY could not read .*Counter\.tla \(exit null\):/);
		assert.match(error.message, /statechart-missing-java/);
		return true;
	});
});
