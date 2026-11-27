import assert from "node:assert/strict";
import { inspect } from "node:util";

import { describe, test } from "vitest";

import { mermaid } from "../src/skills/statechart/scripts/backends/mermaid.ts";
import { report } from "../src/skills/statechart/scripts/backends/report.ts";
import { readConfig } from "../src/skills/statechart/scripts/frontends/config.ts";
import { checkView } from "../src/skills/statechart/scripts/frontends/view.ts";
import type {
	Bug,
	Chart,
	ChartState,
	ChartStep,
	CheckResult,
	Graph,
	Lasso,
	Region,
	Rule,
	Spec,
	State,
	Step,
	Story,
	Value,
	Vars,
} from "../src/skills/statechart/scripts/ir.ts";
import {
	count,
	defaultState,
	holds,
	key,
	list,
	nth,
	pastState,
	regionOf,
	show,
	sortBy,
	stateKey,
	stateRules,
	stateText,
	tupleKey,
	unkey,
	valuesOf,
} from "../src/skills/statechart/scripts/ir.ts";
import { addPast, deadEnds, lasso, mark } from "../src/skills/statechart/scripts/passes/annotate.ts";
import { lift, liftToParents } from "../src/skills/statechart/scripts/passes/lift.ts";
import { compile } from "../src/skills/statechart/scripts/pipeline.ts";

const SAFE: Rule = { kind: "invariant", name: "Safe" };
const LIVE: Rule = { kind: "property", name: "Live" };
const DEADLOCK: Rule = { kind: "deadlock", name: "NoDeadlock" };

const specOf = (over: Partial<Spec> = {}): Spec => ({
	module: "M",
	variables: [],
	invariants: [],
	properties: [],
	deadlock: false,
	written: [],
	...over,
});

const graphState = (vars: Vars, start = false): State => ({ vars, start, breaks: [] });

const graphOf = (entries: [string, State][], steps: Step[] = []): Graph => ({
	states: new Map(entries),
	steps,
});

const move = (from: string, to: string, action = "Inc"): Step => ({ from, to, action });

const chartState = (path: string[], over: Partial<ChartState> = {}): ChartState => ({
	path,
	start: false,
	members: [],
	works: true,
	lead: false,
	repeats: false,
	breaks: [],
	group: undefined,
	...over,
});

const chartStep = (from: string[], to: string[], label: string, when?: string): ChartStep => ({
	from,
	to,
	label,
	when,
});

const region = (name: string, states: ChartState[], steps: ChartStep[] = []): Region => ({
	name,
	states,
	steps,
	arrows: [],
});

const chartOf = (over: Partial<Chart> = {}): Chart => ({
	title: undefined,
	regions: [],
	notes: [],
	inside: 0,
	quiet: 0,
	colors: {},
	paths: [],
	loops: [],
	...over,
});

const checked = (graph: Graph, over: Partial<CheckResult> = {}): CheckResult => ({
	spec: { ...specOf({ deadlock: true }), folder: "/specs" },
	graph,
	paths: undefined,
	rules: [{ rule: DEADLOCK, outcome: "holds", messages: undefined }],
	properties: [],
	exit: 0,
	stop: undefined,
	drawing: undefined,
	states: { distinct: graph.states.size, initial: 1, complete: true, cut: false },
	messages: [],
	...over,
});

const model = (name: string): Value => ({ kind: "model", name });
const setOf = (members: Value[]): Value => ({ kind: "set", members });

describe("the values a chart writes", () => {
	test("writes every TLA+ value the way TLC prints it", () => {
		assert.equal(show(true), "TRUE");
		assert.equal(show(false), "FALSE");
		assert.equal(show(-4), "-4");
		assert.equal(show('a"b\\c'), '"a\\"b\\\\c"');
		assert.equal(show(model("idle")), "idle");
		assert.equal(show({ kind: "interval", lo: 1, hi: 3 }), "1..3");
		assert.equal(show(setOf([true, setOf([])])), "{TRUE, {}}");
		assert.equal(show({ kind: "function", printedAs: "tuple", keys: [1, 2], values: [1, "x"] }), '<<1, "x">>');
		assert.equal(
			show({ kind: "function", printedAs: "record", keys: ["a", "b"], values: [1, true] }),
			"[a |-> 1, b |-> TRUE]",
		);
		assert.equal(
			show({ kind: "function", printedAs: "pairs", keys: [1, 2], values: ["x", "y"] }),
			'(1 :> "x" @@ 2 :> "y")',
		);
	});

	test("names a value the same way whatever order its members arrive in", () => {
		assert.equal(key(setOf([3, 1, 2])), "{1..3}");
		assert.equal(key(setOf([model("b"), model("a"), model("a")])), "{a,b}");
		assert.equal(key(setOf([1, 2, 3, 7, 9, 10])), "{1..3,7,9..10}");
		assert.equal(key({ kind: "interval", lo: 5, hi: 2 }), "{}");
		assert.equal(key({ kind: "function", printedAs: "record", keys: [2, 1], values: ["b", "a"] }), '<<"a","b">>');
		assert.equal(stateKey([1, "a", model("m")]), '1,"a",m');
	});

	test("names a state and lists names the way the report reads them", () => {
		assert.equal(list([]), "");
		assert.equal(list(["a"]), "a");
		assert.equal(list(["a", "b"]), "a and b");
		assert.equal(list(["a", "b", "c"], "or"), "a, b or c");
		assert.equal(defaultState({}), "");
		assert.equal(defaultState({ x: 1 }), "1");
		assert.equal(defaultState({ x: 1, y: setOf([]) }), "x=1 y={}");
		assert.equal(stateText({ x: 1, y: model("m") }), "x = 1 /\\ y = m");
	});

	test("sorts on several keys without losing the ties it already had", () => {
		const sorted = sortBy(count(5), [Int32Array.from([2, 0, 1, 2, 0]), Int32Array.from([9, 1, 1, 0, 3])]);
		assert.deepEqual([...sorted], [1, 4, 2, 3, 0]);
	});

	test("refuses a value or a region it cannot find again", () => {
		assert.throws(() => nth([], 0), /The chart lost track of item 0 of 0\./);
		assert.throws(() => valuesOf({ x: 1 }, ["y"]), /The state x = 1 has no variable y\./);
		assert.throws(() => unkey('{"a":1}'), /The chart cannot read the key \{"a":1\}\./);
		assert.throws(() => regionOf({}, "r"), /The chart lost track of the region r\./);
	});
});

describe("the rules a spec asks TLC to check", () => {
	test("names the deadlock rule CHECK_DEADLOCK only when the spec already uses NoDeadlock", () => {
		assert.deepEqual(stateRules(specOf({ deadlock: true })), [{ kind: "deadlock", name: "NoDeadlock" }]);
		assert.deepEqual(stateRules(specOf({ deadlock: true, invariants: ["NoDeadlock"] })), [
			{ kind: "invariant", name: "NoDeadlock" },
			{ kind: "deadlock", name: "CHECK_DEADLOCK" },
		]);
		assert.deepEqual(stateRules(specOf({ deadlock: true, properties: ["NoDeadlock"] })), [
			{ kind: "deadlock", name: "CHECK_DEADLOCK" },
		]);
		assert.deepEqual(stateRules(specOf({ invariants: ["A"] })), [{ kind: "invariant", name: "A" }]);
	});

	test("holds a move only when every other region matches an and, and when one matches an or", () => {
		const other = (...names: string[]) => names.map((name) => new Set([name]));
		assert.equal(holds({ kind: "and", otherKeys: other("a", "b") }, ["a", "b"]), true);
		assert.equal(holds({ kind: "and", otherKeys: other("a", "b") }, ["a", "c"]), false);
		assert.equal(holds({ kind: "or", otherKeys: other("a", "b") }, ["c", "b"]), true);
		assert.equal(holds({ kind: "or", otherKeys: other("a", "b") }, ["c", "c"]), false);
		assert.equal(holds({ kind: "or", otherKeys: [] }, []), false);
		assert.equal(holds({ kind: "tuples", otherTuples: new Set([tupleKey(["a", "b"])]) }, ["a", "b"]), true);
		assert.equal(holds({ kind: "tuples", otherTuples: new Set() }, ["a", "b"]), false);
	});

	test("keeps one copy of each rule that marks a state outside the constraints", () => {
		assert.deepEqual(pastState({ x: 1 }, true, [SAFE, SAFE], false), {
			vars: { x: 1 },
			start: true,
			breaks: [SAFE],
			ends: [],
			past: true,
			excluded: false,
		});
	});
});

describe("reading a TLC config", () => {
	const read = (text: string) => readConfig({ file: "M.cfg", text });
	const refuses = (text: string, message: RegExp) => assert.throws(() => read(text), message);

	test("records every single-value keyword and every form of a constant", () => {
		const config = read(
			[
				"SPECIFICATION Spec",
				"VIEW View",
				"SYMMETRY Perms",
				"TYPE TypeOK",
				"TYPE_CONSTRAINT Bounds",
				"CONSTRAINT C1 C2",
				"ACTION_CONSTRAINT AC1",
				"CHECK_DEADLOCK FALSE",
				"INIT Init",
				"NEXT Next",
				"CONSTANT N(1, {2}) = 3 Size <- Small Pool <- [M] Default Mutex!Lock = 1",
			].join("\n"),
		);
		assert.deepEqual(
			[
				config.spec,
				config.view,
				config.symmetry,
				config.type,
				config.typeConstraint,
				config.constraints,
				config.actionConstraints,
				config.checkDeadlock,
				config.init,
				config.next,
			],
			["Spec", "View", "Perms", "TypeOK", "Bounds", ["C1", "C2"], ["AC1"], false, "Init", "Next"],
		);
		assert.deepEqual(config.sections[0], { key: "SPECIFICATION", line: 1, tokens: ["Spec"] });
		const constant = config.sections.at(-1);
		assert.equal(constant?.key, "CONSTANT");
		assert.equal(constant?.line, 11);
		assert.deepEqual(constant?.tokens.slice(0, 10), ["N", "(", "1", ",", "{", "2", "}", ")", "=", "3"]);
		assert.deepEqual(constant?.tokens.slice(10, 19), ["Size", "<-", "Small", "Pool", "<-", "[", "M", "]", "Default"]);
		assert.deepEqual(constant?.tokens.slice(19), ["Mutex", "!", "Lock", "=", "1"]);
	});

	test("collects invariant, property, constraint, and action constraint names in order", () => {
		const config = read(
			[
				"INVARIANT A",
				"INVARIANTS B C",
				"PROPERTY P",
				"PROPERTIES Q",
				"CONSTRAINT K",
				"CONSTRAINTS L",
				"ACTION_CONSTRAINT X",
				"ACTION_CONSTRAINTS Y",
			].join("\n"),
		);
		assert.deepEqual(config.invariants, ["A", "B", "C"]);
		assert.deepEqual(config.properties, ["P", "Q"]);
		assert.deepEqual(config.constraints, ["K", "L"]);
		assert.deepEqual(config.actionConstraints, ["X", "Y"]);
		assert.equal(
			config.sections.map((section) => section.key).join(" "),
			"INVARIANT INVARIANT PROPERTY PROPERTY CONSTRAINT CONSTRAINT ACTION_CONSTRAINT ACTION_CONSTRAINT",
		);
	});

	test("reads an empty config, a comment-only config, and a nested comment as empty", () => {
		for (const text of ["", "\\* nothing here", "(* a (* nested *) block *)"]) {
			assert.deepEqual(read(text), {
				sections: [],
				invariants: [],
				properties: [],
				constraints: [],
				actionConstraints: [],
			});
		}
	});

	test("reads the string escapes TLC allows and the CRLF endings Windows writes", () => {
		const config = read('CONSTANT S = "a\\n\\t\\r\\f\\\\\\""\r\nCONSTANT T = "plain"');
		assert.deepEqual(config.sections[0]?.tokens, ["S", "=", '"a\\n\\t\\r\\f\\\\\\""']);
		assert.deepEqual(config.sections[1]?.tokens, ["T", "=", '"plain"']);
		assert.equal(config.sections[1]?.line, 2);
	});

	test("refuses a name TLC would not define, and names the file and line", () => {
		refuses(
			"INIT 1",
			/M\.cfg at line 1\. The initial predicate 1 specified in the configuration file is not defined/,
		);
		refuses("INVARIANT 12", /The invariant 12 specified in the configuration file is not defined/);
		refuses("CONSTANT 1 = 2", /TLC would read 1 as a constant name, and it is not a name/);
	});

	test("refuses a keyword where TLC reads a name, a value, or a constant", () => {
		refuses("INIT NEXT", /TLC would read the keyword NEXT as the name after INIT/);
		refuses("CONSTANT S = INIT", /TLC would read the keyword INIT as a value/);
		refuses("CONSTANT INIT = 1", /It was expecting a keyword, but did not find it/);
		refuses("Init 1", /It was expecting a keyword, but did not find it/);
		refuses("VIEW V\nVIEW W", /The keyword VIEW appeared twice/);
	});

	test("refuses a symbol, a character, or a number that TLC reads another way", () => {
		refuses("CONSTANT X = []", /TLC reads \[\] as one TLA\+ symbol/);
		refuses("CONSTANT X = =<", /TLC reads =< as one TLA\+ symbol/);
		refuses("CONSTANT X - 1", /It cannot read the character "-"/);
		refuses("CONSTANT X = é", /It cannot read the character "é" \(U\+00E9\) outside a string/);
		refuses("CONSTANT X = 1\u00a02", /\(U\+00A0\) outside a string/);
		refuses("CONSTANT X = 12_3", /TLC splits 12_3 into 12 _ 3, because a name needs a letter/);
		refuses("CONSTANT N = {2147483648}", /TLC cannot read a number above 2147483647, such as 2147483648/);
	});

	test("refuses a string or a value that TLC would read differently", () => {
		refuses('CONSTANT S = "a\\q"', /A string has a backslash before "q"/);
		refuses('CONSTANT S = "\u0000"', /A string has the character U\+0000/);
		refuses("CONSTANT S = {1, 2", /It was expecting }, but did not find it/);
		refuses("CONSTANT S =", /It was expecting a value, but did not find it/);
		refuses("CONSTANT X(1 2)", /An operator's arguments are one or more values in \( \)/);
		refuses("CONSTANT X <-", /Expected an identifier after <-\./);
		refuses("CONSTANT X <- [M", /It was expecting \], but did not find it/);
	});

	test("reports the first problem it found once it has read the whole file", () => {
		refuses("INIT 1\nINVARIANT 2", /The initial predicate 1 specified/);
	});
});

describe("lifting arrows to the parent state", () => {
	const parents = [chartState(["A"]), chartState(["B"])];
	const children = [chartState(["A", "x"]), chartState(["A", "y"]), chartState(["B"])];

	test("lifts an arrow to the parent only when every child leaves the same way", () => {
		assert.deepEqual(
			liftToParents(children, [chartStep(["A", "x"], ["B"], "Go"), chartStep(["A", "y"], ["B"], "Go")]),
			[chartStep(["A"], ["B"], "Go")],
		);
		assert.deepEqual(liftToParents(children, [chartStep(["A", "x"], ["B"], "Go")]), [
			chartStep(["A", "x"], ["B"], "Go"),
		]);
		assert.deepEqual(
			liftToParents(children, [chartStep(["A", "x"], ["B"], "Go"), chartStep(["A", "y"], ["B"], "Stop")]),
			[chartStep(["A", "x"], ["B"], "Go"), chartStep(["A", "y"], ["B"], "Stop")],
		);
	});

	test("keeps a step that stays inside the parent, and lifts the deepest parent first", () => {
		assert.deepEqual(
			liftToParents(children, [
				chartStep(["A", "x"], ["A", "y"], "In"),
				chartStep(["A", "x"], ["B"], "Go"),
				chartStep(["A", "y"], ["B"], "Go"),
			]),
			[chartStep(["A", "x"], ["A", "y"], "In"), chartStep(["A"], ["B"], "Go")],
		);
		assert.deepEqual(
			liftToParents(
				[chartState(["A", "B", "x"]), chartState(["A", "B", "y"]), chartState(["C"])],
				[chartStep(["A", "B", "x"], ["C"], "Go"), chartStep(["A", "B", "y"], ["C"], "Go")],
			),
			[chartStep(["A"], ["C"], "Go")],
		);
	});

	test("keeps arrows apart when their guard differs", () => {
		assert.deepEqual(
			liftToParents(children, [
				chartStep(["A", "x"], ["B"], "Go", "n=1"),
				chartStep(["A", "y"], ["B"], "Go", "n=2"),
			]),
			[chartStep(["A", "x"], ["B"], "Go", "n=1"), chartStep(["A", "y"], ["B"], "Go", "n=2")],
		);
	});

	test("draws one arrow for two labels between the same states", () => {
		const steps = [chartStep(["A"], ["B"], "Go"), chartStep(["A"], ["B"], "Stop")];
		const lifted = lift(chartOf({ regions: [region("R", parents, steps)] }));
		assert.deepEqual(lifted.regions[0]?.steps, [chartStep(["A"], ["B"], "Go or Stop")]);
		const guarded = lift(
			chartOf({
				regions: [
					region("R", parents, [chartStep(["A"], ["B"], "Go", "n=1"), chartStep(["A"], ["B"], "Stop", "n=2")]),
				],
			}),
		);
		assert.deepEqual(guarded.regions[0]?.steps, [
			chartStep(["A"], ["B"], "Go", "n=1"),
			chartStep(["A"], ["B"], "Stop", "n=2"),
		]);
	});
});

describe("marking rules on the graph", () => {
	test("marks the state the dump lists and remembers one it leaves out", () => {
		const graph = graphOf(
			[
				["0", graphState({ x: 0 }, true)],
				["1", graphState({ x: 1 })],
			],
			[move("0", "1")],
		);
		const past = mark(
			graph,
			[
				{ values: [1], broken: ["Safe"] },
				{ values: [9], broken: ["Safe"] },
			],
			["x"],
			[SAFE],
		);
		assert.deepEqual(graph.states.get("1")?.breaks, [SAFE]);
		assert.deepEqual([...past.entries()], [["9", new Set([SAFE])]]);
		assert.throws(
			() => mark(graph, [{ values: [1], broken: ["Nope"] }], ["x"], [SAFE]),
			/The chart lost track of "Nope"\./,
		);
	});

	test("marks only the states that no step leaves, and never one outside the constraints", () => {
		const graph = graphOf(
			[
				["0", graphState({ x: 0 }, true)],
				["1", graphState({ x: 1 })],
				["2", graphState({ x: 2 })],
			],
			[move("0", "1")],
		);
		graph.states.set("3", pastState({ x: 3 }, false, [], false));
		graph.steps.push(move("1", "3"));
		deadEnds(graph, DEADLOCK);
		assert.deepEqual(
			[...graph.states].map(([id, state]) => [id, state.breaks]),
			[
				["0", []],
				["1", []],
				["2", [DEADLOCK]],
				["3", []],
			],
		);
	});

	test("adds a state outside the constraints when the trace takes a step TLC does not draw", () => {
		const graph = graphOf(
			[
				["0", graphState({ x: 0 }, true)],
				["1", graphState({ x: 1 })],
				["2", graphState({ x: 2 })],
			],
			[move("0", "1"), move("1", "2")],
		);
		addPast(
			graph,
			[
				{ action: "", vars: { x: 0 } },
				{ action: "Jump", vars: { x: 2 } },
			],
			["x"],
			SAFE,
			new Map(),
			true,
		);
		const added = graph.states.get("past 2 Jump 0");
		assert.equal(added?.past, true);
		assert.equal(added?.excluded, true);
		assert.deepEqual(added?.breaks, [SAFE]);
		assert.deepEqual(added?.ends, [SAFE]);
		assert.deepEqual(graph.steps.at(-1), { from: "0", to: "past 2 Jump 0", action: "Jump" });
	});

	test("marks the drawn state when the trace takes a step the chart already has", () => {
		const graph = graphOf(
			[
				["0", graphState({ x: 0 }, true)],
				["1", graphState({ x: 1 })],
			],
			[move("0", "1")],
		);
		addPast(
			graph,
			[
				{ action: "", vars: { x: 0 } },
				{ action: "Inc", vars: { x: 1 } },
			],
			["x"],
			SAFE,
			new Map(),
			true,
		);
		assert.deepEqual(graph.states.get("1")?.breaks, [SAFE]);
		assert.deepEqual(graph.states.get("1")?.ends, [SAFE]);
		assert.equal(graph.states.size, 2);
		assert.equal(graph.steps.length, 1);
	});

	test("adds a state the dump does not list and calls it initial when the trace has one state", () => {
		const graph = graphOf([["0", graphState({ x: 0 }, true)]]);
		addPast(graph, [{ action: "", vars: { x: 7 } }], ["x"], SAFE, new Map(), false);
		const added = graph.states.get("past 1");
		assert.equal(added?.start, true);
		assert.equal(added?.excluded, false);
		assert.deepEqual(added?.breaks, [SAFE]);
		assert.equal(graph.steps.length, 0);
	});

	test("walks a temporal counterexample into arrows and gives up when the chart has none", () => {
		const graph = graphOf(
			[
				["0", graphState({ x: 0 }, true)],
				["1", graphState({ x: 1 })],
			],
			[move("0", "1", "Up"), move("1", "0", "Down")],
		);
		const found = lasso(
			graph,
			{
				seq: [
					{ action: "", vars: { x: 0 } },
					{ action: "Up", vars: { x: 1 } },
					{ action: "Down", vars: { x: 0 } },
				],
				loop: 0,
			},
			["x"],
		);
		assert.equal(found?.start, "0");
		assert.equal(found?.loop, 0);
		assert.equal(found?.stutters, false);
		assert.deepEqual(
			found?.path.map((step) => [step.action, step.state]),
			[
				["Up", "1"],
				["Down", "0"],
			],
		);
		const stuttering = lasso(
			graph,
			{
				seq: [
					{ action: "", vars: { x: 0 } },
					{ action: "Up", vars: { x: 1 } },
				],
				loop: 1,
			},
			["x"],
		);
		assert.equal(stuttering?.stutters, true);
		assert.equal(
			lasso(
				graph,
				{
					seq: [
						{ action: "", vars: { x: 0 } },
						{ action: "Hover", vars: { x: 1 } },
					],
					loop: undefined,
				},
				["x"],
			),
			undefined,
		);
		assert.equal(lasso(graph, { seq: [], loop: undefined }, ["x"]), undefined);
	});
});

describe("projecting a view onto a chart", () => {
	const sync = () =>
		graphOf(
			[
				["0", graphState({ x: 0, y: 0 }, true)],
				["1", graphState({ x: 1, y: 1 })],
			],
			[move("0", "1", "Sync")],
		);
	const twoRegions = { state: (vars: { x: number; y: number }) => ({ X: `x${vars.x}`, Y: `y${vars.y}` }) };

	test("names a step that changes two regions at once and draws the regions side by side", () => {
		const { report: text, files } = compile(
			checked(sync(), { spec: { ...specOf({ deadlock: true, variables: ["x", "y"] }), folder: "/specs" } }),
			checkView(twoRegions, inspect),
		);
		assert.match(text, /^The step Sync changes X and Y at the same time\.$/m);
		const chart = [...(files.get("chart.mmd") ?? [])].join("");
		assert.match(chart, /direction LR/);
		assert.match(chart, /state "At the same time" as all \{/);
		assert.match(chart, /state "X" as r0 \{/);
		assert.match(chart, /s0 --> s1: Sync/);
		assert.match(chart, /s2 --> s3: Sync/);
	});

	test("says a step changes one region at a time when both regions move on their own", () => {
		const graph = graphOf(
			[
				["0", graphState({ x: 0, y: 0 }, true)],
				["1", graphState({ x: 1, y: 1 })],
				["2", graphState({ x: 1, y: 0 })],
				["3", graphState({ x: 0, y: 1 })],
			],
			[move("0", "2", "Move"), move("2", "1", "Move"), move("1", "3", "Move"), move("3", "0", "Move")],
		);
		const { report: text } = compile(
			checked(graph, { spec: { ...specOf({ deadlock: true, variables: ["x", "y"] }), folder: "/specs" } }),
			checkView(twoRegions, inspect),
		);
		assert.match(text, /The step Move changes only one of X and Y at a time\./);
	});

	test("draws parent states in place of regions when the regions cannot show a move", () => {
		const graph = graphOf(
			[
				["0", graphState({ x: 0, y: 0 }, true)],
				["1", graphState({ x: 1, y: 0 })],
				["2", graphState({ x: 1, y: 1 })],
			],
			[move("0", "1", "Both"), move("1", "2", "Both"), move("0", "2", "Both")],
		);
		const { report: text, files } = compile(
			checked(graph, { spec: { ...specOf({ deadlock: true, variables: ["x", "y"] }), folder: "/specs" } }),
			checkView(twoRegions, inspect),
		);
		assert.match(
			text,
			/which the regions chart cannot show\. So the chart draws parent states in place of regions\./,
		);
		assert.match([...(files.get("chart.mmd") ?? [])].join(""), /state "X x0" as s0 \{/);
	});

	test("counts a step the view returns null for as hidden", () => {
		const graph = graphOf(
			[
				["0", graphState({ x: 0 }, true)],
				["1", graphState({ x: 1 })],
			],
			[move("0", "1")],
		);
		const { report: text, files } = compile(
			checked(graph, { spec: { ...specOf({ deadlock: true, variables: ["x"] }), folder: "/specs" } }),
			checkView(
				{
					state: (vars: { x: number }) => [`x${vars.x}`],
					step: () => null,
				},
				inspect,
			),
		);
		assert.match(text, /The view hides 1 steps, so the chart does not draw them\./);
		assert.doesNotMatch([...(files.get("chart.mmd") ?? [])].join(""), /s0 --> s1/);
	});

	test("refuses a view whose labels would leave the chart unreadable", () => {
		const graph = graphOf(
			[
				["0", graphState({ x: 0 }, true)],
				["1", graphState({ x: 1 })],
				["2", graphState({ x: 2 })],
			],
			[move("0", "1"), move("1", "2")],
		);
		graph.states.get("2")?.breaks.push(SAFE);
		const projection = (view: { readonly [name: string]: unknown }) =>
			compile(
				checked(graph, { spec: { ...specOf({ deadlock: true, variables: ["x"] }), folder: "/specs" } }),
				checkView(view, inspect),
			);
		const shapes = [0, [], "", "undefined", "[object Object]", ["NaN"]];
		for (const shape of shapes)
			assert.throws(
				() => projection({ state: () => shape }),
				/The view's state\(\) returned .+ for the state x = 0\. Return a string, an array of strings, or an object of those\./,
			);
		assert.throws(
			() => projection({ state: (vars: { x: number }) => (vars.x ? ["x"] : { X: ["x"] }) }),
			/The view's state\(\) returned the regions X for one state and {2}for the state x = 1\. Return the same regions for every state\./,
		);
		assert.throws(
			() => projection({ state: () => ["x"], step: () => 3 }),
			/The view's step\(\) returned 3 for the step Inc\./,
		);
		assert.throws(
			() =>
				projection({
					state: (vars: { x: number }) => [`x${vars.x}`],
					step: (action: string) => (action === "Inc" ? null : action),
				}),
			/The view's step\(\) returned null for the step Inc that changes x\. It is on the path to the Safe bug, so label it\./,
		);
	});
});

describe("the report's wording for a counterexample", () => {
	const graph = graphOf(
		[
			["0", graphState({ x: 0 }, true)],
			["1", graphState({ x: 1 })],
		],
		[move("0", "1")],
	);
	const bug: Bug = { rule: LIVE, start: "0", path: [{ action: "Inc", state: "1", step: move("0", "1") }], loop: 1 };
	const story: Story = [{ state: { "": ["x0"] } }, { step: "Inc", state: { "": ["x1"] } }];
	const lassoOf = (found: Bug): Lasso => ({
		start: found.start,
		path: found.path,
		loop: found.loop,
		stutters: found.stutters ?? false,
	});
	const rendering = (broken: Bug) =>
		report(
			checked(graph, {
				rules: [],
				properties: [{ rule: LIVE, outcome: "broken", messages: ["m"], bug: lassoOf(broken), initialOnly: false }],
			}),
			[broken],
			undefined,
			new Map([[broken, story]]),
		);

	test("says a run that loops stays in the state, and a stuttering run stops in it", () => {
		assert.match(
			rendering(bug),
			/## Live breaks\nTLC's counterexample is in tlc-Live\.out\. It has 1 step:\n0\. x0\n1\. Inc: x1\nThe run stays in "x1" forever\./,
		);
		assert.match(rendering({ ...bug, stutters: true }), /The run stops in "x1" forever\./);
	});

	test("names each state the loop passes through", () => {
		const looping: Bug = {
			...bug,
			loop: 0,
			path: [
				{ action: "Inc", state: "1", step: move("0", "1") },
				{ action: "Dec", state: "0", step: move("1", "0", "Dec") },
			],
		};
		const twoStates: Story = [
			{ state: { "": ["x0"] } },
			{ step: "Inc", state: { "": ["x1"] } },
			{ step: "Dec", state: { "": ["x0"] } },
		];
		const text = report(
			checked(graph, {
				rules: [],
				properties: [{ rule: LIVE, outcome: "broken", messages: ["m"], bug: lassoOf(looping), initialOnly: false }],
			}),
			[looping],
			undefined,
			new Map([[looping, twoStates]]),
		);
		assert.match(
			text,
			/It has 2 steps:\n0\. x0\n1\. Inc: x1\n2\. Dec: x0\nThe run loops through "x0" and "x1" forever\./,
		);
	});
});

describe("drawing a chart as Mermaid", () => {
	const arrow = (label: string) => {
		const lines = mermaid(
			chartOf({ regions: [region("M", [chartState(["a"]), chartState(["b"])], [chartStep(["a"], ["b"], label)])] }),
		);
		return lines
			.split("\n")
			.find((line) => line.includes("-->"))
			?.trim();
	};

	test("codes only the characters that would change how Mermaid reads a label", () => {
		for (const [label, drawn] of [
			["plain", "s0 --> s1: plain"],
			["a: b", "s0 --> s1: a: b"],
			["a::b", "s0 --> s1: a#58;:b"],
			["back\\nslash", "s0 --> s1: back#92;nslash"],
			["50% off", "s0 --> s1: 50% off"],
			["[[x", "s0 --> s1: #91;[x"],
			["C4Container", "s0 --> s1: C#52;Container"],
			["direction LR", "s0 --> s1: direction#32;LR"],
			["_lead", "s0 --> s1: #95;lead"],
			["trail_", "s0 --> s1: trail#95;"],
			["a\nb", "s0 --> s1: a b"],
			["an emoji 😀", "s0 --> s1: an emoji #128512;"],
			["a\u0001b", "s0 --> s1: a#1;b"],
		] as const)
			assert.equal(arrow(label), drawn, label);
	});

	test("draws nested parents, regions side by side, and a legend for the marks it used", () => {
		const chart = chartOf({
			title: "Light <b>",
			regions: [
				region(
					"Time",
					[chartState(["a", "x"]), chartState(["a", "y"], { start: true })],
					[chartStep(["a", "x"], ["a", "y"], "Tick")],
				),
				region("Mode", [chartState(["b"], { start: true, group: "g" })]),
			],
			colors: { g: "teal" },
			paths: ["Safe"],
		});
		assert.equal(
			mermaid(chart),
			`---
title: "Light ﬂ°°60¶ßb>"
---
stateDiagram-v2
  direction LR
  state "Legend" as legend {
    lg0: g
  }
  class lg0 teal
  state "At the same time" as all {
    state "Time" as r0 {
      state "a" as s0 {
        s1: x
        s2: y
        [*] --> s2
      }
      [*] --> s0
      s1 --> s2: Tick
    }
    --
    state "Mode" as r1 {
      s3: b
      [*] --> s3
    }
  }
  class s3 teal`,
		);
	});
	test("uses a legend only for the marks the chart actually drew", () => {
		const chart = chartOf({
			regions: [
				region("M", [
					chartState(["a"], { lead: true, repeats: true, breaks: [{ rule: LIVE, always: false }] }),
					chartState(["b"], { works: false, breaks: [{ rule: SAFE, always: true }] }),
				]),
			],
			paths: ["Safe"],
			loops: ["Live"],
		});
		assert.equal(
			mermaid(chart),
			`stateDiagram-v2
  state "Legend" as legend {
    lg0: Breaks Safe
    lg1: Path to the Safe bug
    lg2: Repeats forever, so Live breaks
  }
  class lg0 breaks
  class lg1 bugPath
  class lg2 repeats
  s0: a
  s1: b
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  class s0 bugPath
  class s0 repeats
  class s1 breaks`,
		);
	});
});
