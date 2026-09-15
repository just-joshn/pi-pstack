/**
 * Hermetic tests for extensions/commands/skill-commands.ts.
 * Run: node --experimental-strip-types extensions/test/skill-commands.mjs
 */
import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (err) {
    failed = failed + 1;
    console.error(`FAIL ${name}:`, err?.message ?? err);
  }
}

function fakePi() {
  const registered = new Map();
  return {
    registered,
    calls: [],
    registerCommand(name, options) {
      assert.ok(!registered.has(name), `duplicate registration: ${name}`);
      registered.set(name, options);
    },
    sendUserMessage(content, options) {
      this.calls = [...this.calls, { content, options }];
    },
  };
}

const skillDirNames = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(ROOT, "skills", d.name, "SKILL.md")))
  .map((d) => d.name);

await check("readSkillCommands covers every skill directory, deduped and sorted", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/commands/skill-commands.ts")).href);
  const skills = mod.readSkillCommands();
  const names = skills.map((s) => s.name);
  assert.deepEqual(names, names.toSorted((a, b) => a.localeCompare(b)), "must be sorted");
  assert.equal(new Set(names).size, names.length, "must be deduped");
  for (const dirName of skillDirNames) {
    assert.ok(names.includes(dirName), `missing skill command for ${dirName}`);
  }
  for (const skill of skills) {
    assert.ok(skill.description && skill.description.length > 0, `${skill.name} missing description`);
  }
});

await check("registerSkillCommands skips the reserved set", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/commands/skill-commands.ts")).href);
  const pi = fakePi();
  mod.registerSkillCommands(pi);
  for (const reserved of mod.RESERVED_COMMAND_NAMES) {
    assert.ok(!pi.registered.has(reserved), `must not register reserved name ${reserved}`);
  }
  assert.equal(pi.registered.size, skillDirNames.length - mod.RESERVED_COMMAND_NAMES.filter((r) => skillDirNames.includes(r)).length);
});

await check("registered handler forwards args verbatim into /skill:<name> <args>", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/commands/skill-commands.ts")).href);
  const pi = fakePi();
  mod.registerSkillCommands(pi);
  const how = pi.registered.get("how");
  assert.ok(how, "how must be registered");
  await how.handler("  WHYISMARKER two  ", {});
  assert.equal(pi.calls.length, 1);
  assert.equal(pi.calls[0].content, "/skill:how WHYISMARKER two");
  assert.deepEqual(pi.calls[0].options, { expandPromptTemplates: true });

  const unslop = pi.registered.get("unslop");
  await unslop.handler("", {});
  assert.equal(pi.calls[1].content, "/skill:unslop", "empty args must not leave a trailing space");
});

await check("registerPiOnlyCommands registers babysit/ship/deslop and forwards args", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/commands/skill-commands.ts")).href);
  const pi = fakePi();
  mod.registerPiOnlyCommands(pi);
  assert.deepEqual([...pi.registered.keys()].toSorted(), ["babysit", "deslop", "ship"]);
  const babysit = pi.registered.get("babysit");
  await babysit.handler("PR 42", {});
  assert.ok(pi.calls[0].content.startsWith("Follow poteto-mode playbooks/babysit.md"));
  assert.ok(pi.calls[0].content.endsWith("PR 42"));
});

process.stdout.write((failed ? `\n${failed} failed` : "\nAll checks passed") + "\n");
process.exit(failed ? 1 : 0);
