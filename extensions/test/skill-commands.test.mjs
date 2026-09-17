/**
 * Hermetic tests for extensions/commands/skill-commands.ts.
 * Run: npx vitest run --project extensions
 */
import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function fakePi() {
  const registered = new Map();
  return {
    registered,
    calls: [],
    registerCommand(name, options) {
      expect(!registered.has(name), `duplicate registration: ${name}`).toBeTruthy();
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

test("readSkillCommands covers every skill directory, deduped and sorted", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/commands/skill-commands.ts")).href);
  const skills = mod.readSkillCommands();
  const names = skills.map((s) => s.name);
  expect(names, "must be sorted").toEqual(names.toSorted((a, b) => a.localeCompare(b)));
  expect(new Set(names).size, "must be deduped").toBe(names.length);
  for (const dirName of skillDirNames) {
    expect(names.includes(dirName), `missing skill command for ${dirName}`).toBeTruthy();
  }
  for (const skill of skills) {
    expect(skill.description && skill.description.length > 0, `${skill.name} missing description`).toBeTruthy();
  }
});

test("registerSkillCommands skips the reserved set", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/commands/skill-commands.ts")).href);
  const pi = fakePi();
  mod.registerSkillCommands(pi, { shadowed: [] });
  for (const reserved of mod.RESERVED_COMMAND_NAMES) {
    expect(!pi.registered.has(reserved), `must not register reserved name ${reserved}`).toBeTruthy();
  }
  expect(pi.registered.size).toBe(skillDirNames.length - mod.RESERVED_COMMAND_NAMES.filter((r) => skillDirNames.includes(r)).length);
});

test("registered handler forwards args verbatim into /skill:<name> <args>", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/commands/skill-commands.ts")).href);
  const pi = fakePi();
  mod.registerSkillCommands(pi);
  const how = pi.registered.get("how");
  expect(how, "how must be registered").toBeTruthy();
  await how.handler("  WHYISMARKER two  ", {});
  expect(pi.calls.length).toBe(1);
  expect(pi.calls[0].content).toBe("/skill:how WHYISMARKER two");
  expect(pi.calls[0].options).toEqual({ expandPromptTemplates: true, deliverAs: "followUp" });

  const unslop = pi.registered.get("unslop");
  await unslop.handler("", {});
  expect(pi.calls[1].content, "empty args must not leave a trailing space").toBe("/skill:unslop");
});

test("registerPiOnlyCommands registers babysit/ship and forwards args", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/commands/skill-commands.ts")).href);
  const pi = fakePi();
  mod.registerPiOnlyCommands(pi);
  expect([...pi.registered.keys()].toSorted()).toEqual(["babysit", "ship"]);
  const babysit = pi.registered.get("babysit");
  await babysit.handler("PR 42", {});
  expect(pi.calls[0].content.startsWith("Follow poteto-mode playbooks/babysit.md")).toBeTruthy();
  expect(pi.calls[0].content.endsWith("PR 42")).toBeTruthy();
});
