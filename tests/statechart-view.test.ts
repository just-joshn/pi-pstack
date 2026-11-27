import assert from "node:assert/strict";
import { inspect } from "node:util";

import { test } from "vitest";

import { parseValue } from "../src/skills/statechart/scripts/frontends/value.ts";
import { checkView } from "../src/skills/statechart/scripts/frontends/view.ts";

test("Statechart view callbacks receive JSON values and configured labels", () => {
	const from = { x: parseValue('<<1, "open">>'), choices: parseValue("{closed, open}") };
	const to = { x: parseValue("[left |-> 2, right |-> 3]"), choices: parseValue("1..3") };
	const view = checkView(
		{
			title: "Example",
			state: (vars: unknown) => JSON.stringify(vars),
			step: (action: string, left: unknown, right: unknown) => ({ action, left, right }),
			group: () => "Ready",
			colors: { Ready: "teal" },
		},
		inspect,
	);
	const left = { x: { 1: 1, 2: "open" }, choices: ["closed", "open"] };
	const right = { x: { left: 2, right: 3 }, choices: [1, 2, 3] };
	assert.equal(view.title, "Example");
	assert.equal(view.state?.(from), JSON.stringify(left));
	assert.equal(view.state?.(to), JSON.stringify(right));
	assert.deepEqual(view.step?.("Next", from, to), { action: "Next", left, right });
	assert.equal(view.group?.(from), "Ready");
	assert.equal(view.colors?.Ready, "teal");
});

test("an uncolored Statechart group fails with its name, while an omitted group is allowed", () => {
	const view = checkView({ group: () => "Unknown", colors: { Ready: "teal" } }, inspect);
	assert.throws(() => view.group?.({}), /returned "Unknown", which colors does not name/);
	const ungrouped = checkView({ group: () => undefined, colors: {} }, inspect);
	assert.equal(ungrouped.group?.({}), undefined);
});

test.each([
	[{ extra: true }, /exports extra, which the command does not read/],
	[{ state: "Idle", title: 17 }, /state must be a function and title must be a string/],
	[{ group: () => "Ready" }, /exports group\(\) but no colors/],
	[{ colors: { Ready: "red", Other: 7 } }, /the color "red" and "Other" the color 7/],
] as const)("rejects unsupported Statechart view exports (%j)", (exports, diagnostic) => {
	assert.throws(() => checkView(exports, inspect), diagnostic);
});
