import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "vitest";
import { hasErrorCode } from "../src/support.ts";

test("AGENTS.md links to the single repository rule set", async () => {
	const agents = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
	const linked = [...agents.matchAll(/\]\(docs\/agent-rules\/([^\s/)]+\.md)\)/g)].map((match) => match[1]);
	assert(linked.length > 0, "AGENTS.md must link to docs/agent-rules/");
	assert(!agents.includes(".agents/rules/"), "AGENTS.md must not point to the legacy rules");
	const rules = await readdir(new URL("../docs/agent-rules/", import.meta.url));
	assert.deepEqual(linked.sort(), rules.filter((file) => file.endsWith(".md")).sort());

	const legacy = await readdir(new URL("../.agents/rules/", import.meta.url)).catch((error: unknown) => {
		if (hasErrorCode(error, "ENOENT")) return [];
		throw error;
	});
	assert.deepEqual(
		legacy.filter((file) => file.endsWith(".md")),
		[],
		"Remove legacy rule files after migration",
	);
});
