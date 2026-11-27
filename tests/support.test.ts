import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import { atomicWrite, result } from "../src/support.ts";
import { host, resultText } from "./host.ts";

test("tool results preserve short records and stay within both Pi output limits", () => {
	assert.equal(resultText(result({ ok: true })), '{\n  "ok": true\n}');
	const tooManyBytes = "π".repeat(DEFAULT_MAX_BYTES);
	const tooManyLines = "entry\n".repeat(DEFAULT_MAX_LINES + 1);
	for (const input of [tooManyBytes, tooManyLines]) {
		const output = resultText(result(input));
		assert.match(output, /Output truncated/);
		assert(Buffer.byteLength(output) <= DEFAULT_MAX_BYTES);
		assert(output.split("\n").length <= DEFAULT_MAX_LINES);
	}
});

test("a failed atomic replacement leaves no temporary file behind", async () => {
	const parent = host().artifacts;
	const destination = join(parent, "existing-directory");
	await mkdir(destination, { recursive: true });
	await assert.rejects(() => atomicWrite(destination, "private data"));
	assert.deepEqual(await readdir(parent), ["existing-directory"]);
});
