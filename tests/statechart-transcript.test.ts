import assert from "node:assert/strict";

import { test } from "vitest";

import { plainText, runtime } from "../src/skills/statechart/scripts/backends/plain-text.ts";
import { readMessages } from "../src/skills/statechart/scripts/frontends/messages.ts";
import { EC, LEVEL, type Message } from "../src/skills/statechart/scripts/ir.ts";

const message = (code: number, level: number, ...body: Message["body"]): Message => ({ code, level, body });

test("the plain TLC transcript keeps actionable diagnostics and omits redundant progress", () => {
	const log = plainText([
		message(EC.TLC_SANY_START, 0, "Starting SANY..."),
		message(EC.TLC_SANY_END, 0, "SANY finished."),
		message(EC.TLC_PROGRESS_STATS, 0, "superseded progress"),
		message(EC.TLC_STATS, 0, "3 states generated"),
		message(0, LEVEL.WARNING, "first warning"),
		message(0, LEVEL.WARNING, "second warning"),
		message(0, LEVEL.ERROR, "rule failed", message(0, LEVEL.STATE, "2: Next")),
		message(0, LEVEL.TLCBUG, "internal failure"),
		message(EC.TLC_BACK_TO_STATE, LEVEL.STATE, "1: Back to state: Init"),
		message(EC.TLC_FINISHED, 0, "Finished in 62000ms"),
		message(EC.TLC_PROGRESS_STATS, 0),
		message(EC.TLC_PROGRESS_STATS, 0, "partial progress"),
		"external error",
		message(EC.TLC_PROGRESS_STATS, 0, "last progress"),
	]);
	assert.equal(
		[...log].join(""),
		[
			"3 states generated",
			"Warning: first warning",
			"(Use the -nowarning option to disable this warning.)",
			"Warning: second warning",
			"Error: rule failed",
			"State 2: Next",
			"TLC Bug: internal failure",
			"Back to state 1: Init",
			"Finished in 01min 02s",
			"partial progress",
			"external error",
			"last progress",
			"",
		].join("\n"),
	);
});

test("the transcript preserves text outside TLC message markers", () => {
	const lines = ["startup diagnostic", "prefix @!@!@STARTMSG 2262:0 @!@!@", "TLC2", "@!@!@ENDMSG 2262 @!@!@"];
	assert.equal([...plainText(readMessages(lines))].join(""), "startup diagnostic\nprefix TLC2\n");
});

test.each([
	[9_000, "09s"],
	[65_000, "01min 05s"],
	[3_720_000, "01h 02min"],
	[180_000_000, "2d 02h"],
] as const)("a TLC runtime of %d milliseconds is printed as %s", (ms, expected) => {
	assert.equal(runtime(ms), expected);
});
