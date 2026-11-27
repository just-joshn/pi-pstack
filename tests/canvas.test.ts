import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "vitest";

test("the review canvas renders diffs and reports malformed data without exposing it", async () => {
	const filename = new URL("../src/skills/pr-review-canvas/renderer.js", import.meta.url);
	const renderer = await readFile(filename, "utf8");
	const payload = { textContent: JSON.stringify({ file: ["@@ -1 +1 @@", "-old", "+<new>"] }) };
	const target = { innerHTML: "", textContent: "", getAttribute: () => "file" };
	let ready: (() => void) | undefined;
	const document = {
		getElementById: () => payload,
		querySelectorAll: () => [target],
		addEventListener(event: string, listener: () => void) {
			assert.equal(event, "DOMContentLoaded");
			ready = listener;
		},
	};
	runInNewContext(renderer, { document, window: {} }, { filename: filename.href, timeout: 1_000 });
	assert(ready);
	ready();
	assert.match(target.innerHTML, /diff-add[^>]*>.*&lt;new&gt;/);
	assert.doesNotMatch(target.innerHTML, /<new>/);

	payload.textContent = "{dummy-secret";
	ready();
	assert.equal(target.textContent, "Could not read PR diff data.");
});
