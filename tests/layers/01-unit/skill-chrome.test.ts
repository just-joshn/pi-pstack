import { expect, test } from "vitest";
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
  expect(chrome).toEqual({ icon: "crown", color: "yellow", reminder: "stay concise" });

  const bare = parseSkillChrome("plain markdown\n");
  expect(bare).toEqual({ icon: undefined, color: undefined, reminder: undefined });
});

test("skill-chrome-02 the shipped poteto skill declares the chrome the parser returns", () => {
  const chrome = readSkillChrome(POTETO_SKILL);
  expect(chrome?.icon).toBe("crown");
  expect(chrome?.color).toBe("yellow");
  expect(typeof chrome?.reminder).toBe("string");
  expect(chrome?.reminder?.includes("/poteto-mode")).toBe(true);
});

test("skill-chrome-03 splitFrontmatter keeps stripFrontmatter behavior and drops the block", () => {
  const raw = ["---", "name: x", "icon: crown", "---", "body text", ""].join("\n");
  expect(splitFrontmatter(raw).body).toBe(stripFrontmatter(raw));
  expect(splitFrontmatter(raw).fields).toEqual({ name: "x", icon: "crown" });
  expect(stripFrontmatter("plain text\n")).toBe("plain text");
  expect(stripFrontmatter("---\nunclosed\n")).toBe("---\nunclosed");
});

test("skill-chrome-04 maps declared colors onto theme tokens", () => {
  expect(chromeThemeToken("yellow")).toBe("warning");
  expect(chromeThemeToken("YELLOW")).toBe("warning");
  expect(chromeThemeToken("green")).toBe("success");
  expect(chromeThemeToken("chartreuse")).toBe(undefined);
  expect(chromeThemeToken(undefined)).toBe(undefined);
  expect(chromeStatusLabel({ icon: "crown" }, "poteto-mode")).toBe("crown poteto-mode");
  expect(chromeStatusLabel({}, "solo")).toBe("solo");
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
    expect(statuses).toEqual([["pstack-skill", "[warning]crown demo"]]);

    await commands.get("demo")?.handler("", {});
    expect(statuses.length, "a headless context must not throw or record").toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill-chrome-06 the poteto reminder reaches the sticky inject", () => {
  clearPotetoStickyCache();
  const reminder = loadPotetoReminder();
  expect(typeof reminder).toBe("string");
  expect(reminder?.includes("/poteto-mode")).toBe(true);
  expect(loadPotetoReminder(), "the reminder is cached").toBe(reminder);

  const prompt = buildPotetoStickyPrompt("BASE");
  expect(prompt.includes(`Reminder: ${reminder}`), "the declared reminder is injected").toBe(true);
});
