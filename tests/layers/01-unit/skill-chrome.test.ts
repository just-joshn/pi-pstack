import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromeStatusLabel,
  chromeThemeToken,
  parseSkillChrome,
  readSkillChrome,
  splitFrontmatter,
} from "../../../extensions/lib/skill-chrome.ts";
import { registerSkillCommands } from "../../../extensions/commands/skill-commands.ts";
import { POTETO_SKILL, buildPotetoStickyPrompt, clearPotetoStickyCache, loadPotetoReminder, stripFrontmatter } from "../../../extensions/sticky-poteto.ts";

function writeSkill(root: string, name: string, lines: string[]): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, ["---", ...lines, "---", "", `# ${name}`, ""].join("\n"), "utf8");
  return path;
}

test("skill-chrome-01 reads icon, color, and reminder from the file frontmatter", () => {
  const chrome = parseSkillChrome(
    ["---", "name: demo", "icon: crown", "color: yellow", "reminder: stay concise", "---", "body"].join("\n"),
  );
  assert.deepEqual(chrome, { icon: "crown", color: "yellow", reminder: "stay concise" });

  const bare = parseSkillChrome("plain markdown\n");
  assert.deepEqual(bare, { icon: undefined, color: undefined, reminder: undefined });
});

test("skill-chrome-02 the shipped poteto skill declares the chrome the parser returns", () => {
  const chrome = readSkillChrome(POTETO_SKILL);
  assert.equal(chrome?.icon, "crown");
  assert.equal(chrome?.color, "yellow");
  assert.equal(typeof chrome?.reminder, "string");
  assert.equal(chrome?.reminder?.includes("/poteto-mode"), true);
});

test("skill-chrome-03 splitFrontmatter keeps stripFrontmatter behavior and drops the block", () => {
  const raw = ["---", "name: x", "icon: crown", "---", "body text", ""].join("\n");
  assert.equal(splitFrontmatter(raw).body, stripFrontmatter(raw));
  assert.deepEqual(splitFrontmatter(raw).fields, { name: "x", icon: "crown" });
  assert.equal(stripFrontmatter("plain text\n"), "plain text");
  assert.equal(stripFrontmatter("---\nunclosed\n"), "---\nunclosed");
});

test("skill-chrome-04 maps declared colors onto theme tokens", () => {
  assert.equal(chromeThemeToken("yellow"), "warning");
  assert.equal(chromeThemeToken("YELLOW"), "warning");
  assert.equal(chromeThemeToken("green"), "success");
  assert.equal(chromeThemeToken("chartreuse"), undefined);
  assert.equal(chromeThemeToken(undefined), undefined);
  assert.equal(chromeStatusLabel({ icon: "crown" }, "poteto-mode"), "crown poteto-mode");
  assert.equal(chromeStatusLabel({}, "solo"), "solo");
});

test("skill-chrome-05 a skill command renders its chrome through ctx.ui.setStatus", async () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-skill-chrome-"));
  try {
    writeSkill(root, "demo", ["name: demo", "description: Demo chrome.", "icon: crown", "color: yellow"]);
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        commands.set(name, spec);
      },
      sendUserMessage() {},
    };
    registerSkillCommands(pi as never, { skillsDir: root });

    let statuses: Array<[string, string | undefined]> = [];
    const ctx = {
      ui: {
        setStatus: (key: string, value: string | undefined) => {
          statuses = [...statuses, [key, value]];
        },
        theme: { fg: (token: string, text: string) => `[${token}]${text}` },
      },
    };
    await commands.get("demo")?.handler("", ctx);
    assert.deepEqual(statuses, [["pstack-skill", "[warning]crown demo"]]);

    await commands.get("demo")?.handler("", {});
    assert.equal(statuses.length, 1, "a headless context must not throw or record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill-chrome-06 the poteto reminder reaches the sticky inject", () => {
  clearPotetoStickyCache();
  const reminder = loadPotetoReminder();
  assert.equal(typeof reminder, "string");
  assert.equal(reminder?.includes("/poteto-mode"), true);
  assert.equal(loadPotetoReminder(), reminder, "the reminder is cached");

  const prompt = buildPotetoStickyPrompt("BASE");
  assert.equal(prompt.includes(`Reminder: ${reminder}`), true, "the declared reminder is injected");
});
