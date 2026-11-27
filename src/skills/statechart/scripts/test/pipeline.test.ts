import assert from "node:assert/strict";
import { inspect } from "node:util";
import { parseDot } from "../frontends/dot.ts";
import { readMessages } from "../frontends/messages.ts";
import { checkView } from "../frontends/view.ts";
import type { CheckResult, Property, Rule, Verdict } from "../ir.ts";
import { pathGraph } from "../passes/paths.ts";
import { compile } from "../pipeline.ts";
import { describe, test } from "./runner.ts";

const DEADLOCK: Rule = { kind: "deadlock", name: "deadlock" };

const lightDot = (steps: [string, string, string][]) =>
	[
		String.raw`1 [label="/\\ light = \"red\"",style = filled]`,
		String.raw`2 [label="/\\ light = \"green\""]`,
		String.raw`3 [label="/\\ light = \"yellow\""]`,
		...steps.map(([from, to, action]) => `${from} -> ${to} [label="${action}"];`),
	].join("\n");

const result = (dot: string, rules: Verdict[], exit: CheckResult["exit"], properties: Property[] = []): CheckResult => {
	const graph = parseDot(dot);
	return {
		spec: {
			module: "Light",
			variables: ["light"],
			invariants: [],
			properties: properties.map((p) => p.rule.name),
			deadlock: true,
			written: [],
			folder: "/specs",
		},
		graph,
		paths: undefined,
		rules,
		properties,
		exit,
		stop: undefined,
		drawing: undefined,
		states: { distinct: graph.states.size, initial: 1, complete: true, cut: false },
		messages: [],
	};
};

const text = (files: Map<string, Iterable<string | Uint8Array>>, name: string) => {
	const parts = files.get(name);
	assert.ok(parts, `expected ${name} in ${[...files.keys()].join(", ")}`);
	return [...parts].join("");
};

describe("compile", () => {
	test("draws a cycle where every rule holds and exits 0", () => {
		const dot = lightDot([
			["1", "2", "Go"],
			["2", "3", "Slow"],
			["3", "1", "Stop"],
		]);
		const { report, files, exit } = compile(
			result(dot, [{ rule: DEADLOCK, outcome: "holds", messages: undefined }], 0),
			checkView({}, inspect),
		);
		assert.equal(exit, 0);
		assert.deepEqual([...files.keys()], ["chart.mmd", "report.md", "tlc.out"]);
		assert.equal(text(files, "report.md"), report);
		assert.match(report, /^# Light\n/);
		assert.match(report, /TLC reached 3 states and 3 steps\./);
		assert.match(report, /## Rules that hold\ndeadlock/);
		assert.equal(
			text(files, "chart.mmd"),
			[
				"stateDiagram-v2",
				'  s0: "red"',
				'  s1: "green"',
				'  s2: "yellow"',
				"  [*] --> s0",
				"  s0 --> s1: Go",
				"  s1 --> s2: Slow",
				"  s2 --> s0: Stop",
			].join("\n"),
		);
	});

	test("reports the shortest path to a deadlock through the view and exits 1", () => {
		const dot = lightDot([
			["1", "2", "Go"],
			["2", "3", "Slow"],
		]);
		const messages = [...readMessages("@!@!@STARTMSG 2114:1 @!@!@\nDeadlock reached.\n@!@!@ENDMSG 2114 @!@!@")];
		const checked = result(dot, [{ rule: DEADLOCK, outcome: "broken", messages }], 1);
		checked.graph.states.get("3")?.breaks.push(DEADLOCK);
		checked.messages = messages;
		const view = checkView(
			{ state: (vars: { light: string }) => vars.light.toUpperCase(), title: "Traffic" },
			inspect,
		);
		const { report, files, exit } = compile(checked, view);
		assert.equal(exit, 1);
		assert.match(
			report,
			/## deadlock breaks\nThe shortest path has 2 steps:\n0\. RED\n1\. Go: GREEN\n2\. Slow: YELLOW/,
		);
		const chart = text(files, "chart.mmd");
		assert.match(chart, /^---\ntitle: "Traffic"\n---\nstateDiagram-v2\n/);
		assert.match(chart, /class s2 breaks/);
		assert.equal(text(files, "tlc.out"), "Error: Deadlock reached.\n");
	});

	test("draws both regions and labels moves that depend on the other region", () => {
		const dot = [
			String.raw`1 [label="/\\ x = 0\n/\\ y = 0",style = filled]`,
			String.raw`2 [label="/\\ x = 1\n/\\ y = 0"]`,
			String.raw`3 [label="/\\ x = 1\n/\\ y = 1"]`,
			String.raw`4 [label="/\\ x = 0\n/\\ y = 1"]`,
			'1 -> 2 [label="FlipX"];',
			'2 -> 3 [label="FlipY"];',
			'3 -> 4 [label="FlipX"];',
			'4 -> 1 [label="FlipY"];',
		].join("\n");
		const checked = result(dot, [{ rule: DEADLOCK, outcome: "holds", messages: undefined }], 0);
		checked.spec = { ...checked.spec, module: "XY", variables: ["x", "y"] };
		const view = checkView({ state: ({ x, y }: { x: number; y: number }) => ({ X: `x${x}`, Y: `y${y}` }) }, inspect);
		const { files, report } = compile(checked, view);
		const chart = text(files, "chart.mmd");
		assert.match(chart, /state "X" as r0/);
		assert.match(chart, /state "Y" as r1/);
		assert.match(chart, /FlipX \[when y0\]/);
		assert.match(chart, /FlipY \[when x1\]/);
		assert.match(report, /TLC reached 4 states and 4 steps\. The chart draws 4 states and 4 arrows\./);
	});

	test("draws just the temporal counterexample after the model exceeds the chart budget", () => {
		const paths = pathGraph(["light"]);
		const bug = paths.lasso({
			seq: [
				{ action: "", vars: { light: "red" } },
				{ action: "Go", vars: { light: "green" } },
				{ action: "Slow", vars: { light: "yellow" } },
				{ action: "Stop", vars: { light: "red" } },
			],
			loop: 0,
		});
		assert(bug);
		const properties: Property[] = [
			{
				rule: { kind: "property", name: "Live" },
				outcome: "broken",
				messages: [
					...readMessages(
						"@!@!@STARTMSG 2116:1 @!@!@\nTemporal properties were violated.\n@!@!@ENDMSG 2116 @!@!@",
					),
				],
				bug,
				initialOnly: false,
			},
		];
		const checked: CheckResult = {
			...result("", [], 1, properties),
			graph: paths.graph,
			paths: [],
			states: { distinct: 1200, initial: 1, complete: true, cut: false },
		};
		const view = checkView({ state: (vars: { light: string }) => vars.light.toUpperCase() }, inspect);
		const { files, exit, report } = compile(checked, view);
		assert.equal(exit, 1);
		assert.match(report, /TLC reached 1,200 states, more than the chart budget of 500/);
		assert.match(report, /0\. RED\n1\. Go: GREEN\n2\. Slow: YELLOW\n3\. Stop: RED/);
		assert.match(report, /The run loops through "RED", "GREEN" and "YELLOW" forever\./);
		const chart = text(files, "chart.mmd");
		assert.match(chart, /Repeats forever, so Live breaks/);
		assert.doesNotMatch(chart, /bugPath/);
		assert.match(text(files, "tlc-Live.out"), /Temporal properties were violated/);
	});

	test("names the missing variable when a counterexample trace is incomplete", () => {
		const graph = pathGraph(["light", "phase"]);
		assert.throws(() => graph.bug(DEADLOCK, [{ action: "Init", vars: { light: "red" } }]), /has no variable phase/);
	});

	test("writes TLC's own output for a broken property it cannot draw", () => {
		const dot = lightDot([
			["1", "2", "Go"],
			["2", "3", "Slow"],
			["3", "1", "Stop"],
		]);
		const live: Rule = { kind: "property", name: "Live" };
		const messages = [
			...readMessages("@!@!@STARTMSG 2116:1 @!@!@\nTemporal properties were violated.\n@!@!@ENDMSG 2116 @!@!@"),
		];
		const { files, exit } = compile(
			result(dot, [{ rule: DEADLOCK, outcome: "holds", messages: undefined }], 1, [
				{ rule: live, outcome: "broken", messages, bug: undefined, initialOnly: false },
			]),
			checkView({}, inspect),
		);
		assert.equal(exit, 1);
		assert.equal(text(files, "tlc-Live.out"), "Error: Temporal properties were violated.\n");
	});
});
