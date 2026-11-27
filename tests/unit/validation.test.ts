import assert from "node:assert/strict";

import { test } from "vitest";

import { errorMessage, isRecord, parseJson } from "../../src/lib/validation.ts";

test("only plain non-null objects count as records", () => {
	assert.equal(isRecord({}), true);
	assert.equal(isRecord({ key: 1 }), true);
	for (const value of [null, undefined, [], "text", "", 0, true]) assert.equal(isRecord(value), false);
});

test("an error message comes from an Error or from the thrown value itself", () => {
	assert.equal(errorMessage(new Error("broken")), "broken");
	assert.equal(errorMessage("plain"), "plain");
	assert.equal(errorMessage(42), "42");
	assert.equal(errorMessage(undefined), "undefined");
});

test("parsed JSON keeps its value, and invalid JSON names the source without its contents", () => {
	assert.deepEqual(parseJson('{"a":[1]}', "config"), { a: [1] });
	assert.equal(parseJson("null", "config"), null);
	for (const source of ["", "{", "secret-token"])
		assert.throws(
			() => parseJson(source, "config"),
			(error: unknown) =>
				error instanceof Error && error.message === "Invalid JSON in config" && !error.message.includes("secret"),
		);
});
