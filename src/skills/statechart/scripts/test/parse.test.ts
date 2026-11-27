import assert from "node:assert/strict";
import { inspect } from "node:util";
import { readConfig } from "../frontends/config.ts";
import { parseDot, parseState } from "../frontends/dot.ts";
import { readMarks } from "../frontends/marks.ts";
import { readMessages } from "../frontends/messages.ts";
import { readCounterexample, readTrace } from "../frontends/trace.ts";
import { parseValue } from "../frontends/value.ts";
import { readVerdict } from "../frontends/verdict.ts";
import { checkView } from "../frontends/view.ts";
import { describe, test } from "./runner.ts";

describe("parseValue", () => {
	test("reads scalars, strings with escapes, and model values", () => {
		assert.equal(parseValue("TRUE"), true);
		assert.equal(parseValue("FALSE"), false);
		assert.equal(parseValue("-42"), -42);
		assert.equal(parseValue(String.raw`"a\"b\\c\nd"`), 'a"b\\c\nd');
		assert.deepEqual(parseValue("idle"), { kind: "model", name: "idle" });
	});

	test("reads sets, intervals, tuples, records, and function pairs", () => {
		assert.deepEqual(parseValue("{1, 2}"), { kind: "set", members: [1, 2] });
		assert.deepEqual(parseValue("{}"), { kind: "set", members: [] });
		assert.deepEqual(parseValue("1..3"), { kind: "interval", lo: 1, hi: 3 });
		assert.deepEqual(parseValue('<<1, "x">>'), {
			kind: "function",
			printedAs: "tuple",
			keys: [1, 2],
			values: [1, "x"],
		});
		assert.deepEqual(parseValue("[a |-> 1, b |-> TRUE]"), {
			kind: "function",
			printedAs: "record",
			keys: ["a", "b"],
			values: [1, true],
		});
		assert.deepEqual(parseValue('(1 :> "x" @@ 2 :> "y")'), {
			kind: "function",
			printedAs: "pairs",
			keys: [1, 2],
			values: ["x", "y"],
		});
	});

	test("rejects malformed values and names where it stopped", () => {
		assert.throws(() => parseValue("{1, 2"), /cannot read TLA\+ value/);
		assert.throws(() => parseValue("1 2 3"), /cannot read TLA\+ value at "2 3"/);
		assert.throws(() => parseValue('"open'), /cannot read TLA\+ value at ""open"/);
		assert.throws(() => parseValue("[1 |-> 2]"), /cannot read TLA\+ value/);
		assert.throws(() => parseValue(String.raw`"\q"`), /cannot read TLA\+ value/);
		assert.throws(() => parseValue(""), /cannot read TLA\+ value/);
	});
});

describe("readConfig", () => {
	test("reads sections, lists, and the deadlock flag", () => {
		const config = readConfig({
			file: "M.cfg",
			text: [
				"\\* a comment",
				"CONSTANTS N = 3 Procs = {p1, p2}",
				"(* nested (* block *) comment *)",
				"INIT Init",
				"NEXT Next",
				"INVARIANTS TypeOK Safe",
				"PROPERTY Live",
				"CHECK_DEADLOCK FALSE",
			].join("\n"),
		});
		assert.equal(config.init, "Init");
		assert.equal(config.next, "Next");
		assert.deepEqual(config.invariants, ["TypeOK", "Safe"]);
		assert.deepEqual(config.properties, ["Live"]);
		assert.equal(config.checkDeadlock, false);
		assert.deepEqual(config.sections[0], {
			key: "CONSTANT",
			line: 2,
			tokens: ["N", "=", "3", "Procs", "=", "{", "p1", ",", "p2", "}"],
		});
	});

	test("names the file and line of each refusal", () => {
		const refuses = (text: string, message: RegExp) =>
			assert.throws(() => readConfig({ file: "M.cfg", text }), message);
		refuses("INIT Init\nINIT Other", /M\.cfg at line 2\. The keyword INIT appeared twice/);
		refuses("Init", /line 1\. It was expecting a keyword/);
		refuses("INIT", /The keyword INIT was not followed by an identifier/);
		refuses("CHECK_DEADLOCK maybe", /expecting TRUE or FALSE/);
		refuses("INIT Init\n(* open", /line 2\. A comment starts here and does not end/);
		refuses('CONSTANT S = "a\nb"', /does not end on its line/);
		refuses("\uFEFFINIT Init", /byte order mark/);
		refuses("INIT Init # x", /cannot read the character "#"/);
		refuses("INVARIANT WF_x", /TLC reads WF_ at the start of a word/);
		refuses("CONSTANT N = 2147483648", /number above 2147483647/);
	});
});

describe("parseDot", () => {
	const dot = [
		"digraph DiskGraph {",
		String.raw`1 [label="/\\ n = 0\n/\\ s = {\"a\"}",style = filled]`,
		String.raw`2 [label="/\\ n = 1\n/\\ s = {}"]`,
		'1 -> 2 [label="Inc",color="black",fontcolor="black"];',
		'2 -> 2 [label="Stay",color="black",fontcolor="black"];',
		"}",
	].join("\n");

	test("reads states, start marks, and labeled steps", () => {
		const graph = parseDot(dot);
		assert.deepEqual([...graph.states.keys()], ["1", "2"]);
		assert.deepEqual(graph.states.get("1"), {
			vars: { n: 0, s: { kind: "set", members: ["a"] } },
			start: true,
			breaks: [],
		});
		assert.equal(graph.states.get("2")?.start, false);
		assert.deepEqual(graph.steps, [
			{ from: "1", to: "2", action: "Inc" },
			{ from: "2", to: "2", action: "Stay" },
		]);
	});

	test("accepts CRLF input and an iterable of lines", () => {
		assert.deepEqual(parseDot(dot.replaceAll("\n", "\r\n")), parseDot(dot));
		assert.deepEqual(parseDot(dot.split("\n")), parseDot(dot));
	});

	test("rejects a step to a state it does not list", () => {
		assert.throws(
			() => parseDot(`${dot}\n2 -> 9 [label="Jump"];`),
			/step Jump to or from a state that it does not list/,
		);
	});

	test("rejects a state line it cannot read", () => {
		assert.throws(() => parseState("/\\ = 1"), /cannot read the TLC state line "= 1"/);
	});
});

describe("readMessages", () => {
	test("nests TLC messages and passes loose lines through", () => {
		const out = [
			"plain line",
			"@!@!@STARTMSG 2110:1 @!@!@",
			"Invariant Safe is violated.",
			"@!@!@STARTMSG 2217:4 @!@!@",
			"1: <Initial predicate>",
			"@!@!@ENDMSG 2217 @!@!@",
			"@!@!@ENDMSG 2110 @!@!@",
		].join("\n");
		assert.deepEqual(
			[...readMessages(out)],
			[
				"plain line",
				{
					code: 2110,
					level: 1,
					body: ["Invariant Safe is violated.", { code: 2217, level: 4, body: ["1: <Initial predicate>"] }],
				},
			],
		);
	});

	test("yields a message that TLC cut off mid-output", () => {
		const out = "@!@!@STARTMSG 1000:1 @!@!@\nTLC threw an unexpected exception.\n";
		assert.deepEqual(
			[...readMessages(out)],
			[{ code: 1000, level: 1, body: ["TLC threw an unexpected exception."] }],
		);
	});
});

describe("TLC transcripts", () => {
	const traceHead = [
		"@!@!@STARTMSG 2107:1 @!@!@",
		"Invariant Safe is violated by the initial state:",
		"/\\ x = 0",
		"@!@!@ENDMSG 2107 @!@!@",
		"@!@!@STARTMSG 2217:4 @!@!@",
		"2: <Increment line 5>",
		"/\\ x = 1",
		"@!@!@ENDMSG 2217 @!@!@",
	];
	const initial = { action: "", vars: { x: 0 } };
	const next = { action: "Increment", vars: { x: 1 } };

	test("a safety trace keeps later states while a temporal trace closes on a back edge", () => {
		const output = [
			...traceHead,
			"@!@!@STARTMSG 2122:4 @!@!@",
			"1: Back to state: <Reset>",
			"@!@!@ENDMSG 2122 @!@!@",
			"@!@!@STARTMSG 2217:4 @!@!@",
			"3: <Later line 7>",
			"/\\ x = 2",
			"@!@!@ENDMSG 2217 @!@!@",
		].join("\n");
		assert.deepEqual(readCounterexample(readMessages(output)), [initial, next, { action: "Later", vars: { x: 2 } }]);
		assert.deepEqual(readTrace(readMessages(output)), {
			seq: [initial, next, { action: "Reset", vars: { x: 0 } }],
			loop: 0,
		});
	});

	test("a stuttering trace loops at the final state, while finite output has no loop", () => {
		const finite = traceHead.join("\n");
		const stuttering = [...traceHead, "@!@!@STARTMSG 2218:4 @!@!@", "3: Stuttering", "@!@!@ENDMSG 2218 @!@!@"];
		assert.deepEqual(readTrace(readMessages(finite)), { seq: [initial, next], loop: undefined });
		assert.deepEqual(readTrace(readMessages(stuttering)), { seq: [initial, next], loop: 1 });
	});

	test("the first rule failure remains the verdict after later state counts", () => {
		const output = [
			"@!@!@STARTMSG 2191:0 @!@!@",
			"3 states generated, with 2 of them distinct.",
			"@!@!@ENDMSG 2191 @!@!@",
			...traceHead,
			"@!@!@STARTMSG 2116:1 @!@!@",
			"Temporal properties were violated.",
			"@!@!@ENDMSG 2116 @!@!@",
			"@!@!@STARTMSG 2199:0 @!@!@",
			"9 states generated, 7 distinct states found.",
			"@!@!@ENDMSG 2199 @!@!@",
		];
		assert.deepEqual(readVerdict(readMessages(output)), {
			broke: { kind: "invariant", name: "Safe" },
			distinct: 7,
			initial: 3,
		});
	});

	test("matches the active marker across lines and rejects incomplete or malformed marks", () => {
		const output = ['<<"stale", <<9>>, {"Ignored"}>>', '<<"active", <<1,', '  {2, 3}>>, {"Safe"}>>'];
		assert.deepEqual(
			[...readMarks(readMessages(output), "active")],
			[{ values: [1, { kind: "set", members: [2, 3] }], broken: ["Safe"] }],
		);
		assert.throws(() => [...readMarks(['<<"active", <<1,'], "active")], /output ends inside a marked state/);
		assert.throws(() => [...readMarks(['<<"active", <<1>>, {2}>>'], "active")], /mark that the command cannot read/);
	});
});

describe("checkView", () => {
	test("projects TLA+ values to JSON for the view's functions", () => {
		const view = checkView(
			{
				state: (vars: { s: unknown }) => vars.s,
				group: () => "g",
				colors: { g: "teal" },
				title: "T",
			},
			inspect,
		);
		assert.deepEqual(view.state?.({ s: { kind: "interval", lo: 1, hi: 3 } }), [1, 2, 3]);
		assert.equal(view.group?.({}), "g");
		assert.equal(view.title, "T");
	});

	test("rejects exports, types, and colors it cannot use", () => {
		assert.throws(() => checkView({ extra: 1 }, inspect), /exports extra, which the command/);
		assert.throws(() => checkView({ state: "x" }, inspect), /state must be a function/);
		assert.throws(() => checkView({ group: () => "g" }, inspect), /group\(\) but no colors/);
		assert.throws(() => checkView({ colors: { g: "red" } }, inspect), /"g" the color "red"/);
		const view = checkView({ group: () => "h", colors: { g: "blue" } }, inspect);
		assert.throws(() => view.group?.({}), /returned "h", which colors does not name/);
	});
});
