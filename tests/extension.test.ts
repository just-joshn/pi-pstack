import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { test } from "vitest";

import { slashSkills } from "../src/lib/catalog.ts";
import { host } from "./host.ts";
import { assumeShape } from "./support.ts";

interface Manifest {
	files: string[];
	pi: { extensions: string[]; skills: string[] };
}

test("mock host registers all 53 slash skills and 10 native tools", () => {
	const h = host();
	assert.equal(slashSkills.length, 53);
	for (const skill of slashSkills) assert(h.commands.has(skill.label.slice(1)), skill.id);
	assert.equal(h.tools.size, 10);
	assert(h.events.has("before_agent_start"));
	assert(h.events.has("session_shutdown"));
});

test("the package allowlists source and docs, but not nested dependency installs", async () => {
	const manifest = assumeShape<Manifest>(
		JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")),
	);
	assert.deepEqual(manifest.files, ["src/", "!src/**/node_modules", "README.md", "CHANGELOG.md", "LICENSE"]);
	for (const path of [...manifest.pi.extensions, ...manifest.pi.skills]) assert.match(path, /^src\//);
});
