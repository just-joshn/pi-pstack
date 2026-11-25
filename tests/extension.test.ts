import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { test } from "vitest";

import { slashSkills } from "../src/lib/catalog.ts";
import { host } from "./host.ts";
import { shaped } from "./support.ts";

interface Manifest {
  files: string[];
  pi: { extensions: string[]; skills: string[] };
}

test("mock host registers all 52 slash skills and 9 native tools", () => {
  const h = host();
  assert.equal(slashSkills.length, 52);
  for (const skill of slashSkills) assert(h.commands.has(skill.label.slice(1)), skill.id);
  assert.equal(h.tools.size, 9);
  assert(h.events.has("before_agent_start"));
  assert(h.events.has("session_shutdown"));
});

test("the package publishes only src, and Pi loads the extension and skills from it", async () => {
  const manifest = shaped<Manifest>(
    JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")),
  );
  assert.deepEqual(manifest.files, ["src"]);
  for (const path of [...manifest.pi.extensions, ...manifest.pi.skills])
    assert.match(path, /^src\//);
});
