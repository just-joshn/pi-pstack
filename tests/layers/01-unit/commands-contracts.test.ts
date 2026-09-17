/**
 * Behavioral ledger proofs for the commands surface (spec/contracts/content.tsv).
 * Drives the real skill-command and poteto-state registration modules through fake pi hosts.
 */
import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/repo-root.mjs";
import { readSkillCommands, registerSkillCommands } from "../../../extensions/commands/skill-commands.ts";
import { createPotetoRuntime } from "../../../extensions/poteto-state/index.ts";

interface CommandDefinition {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface RecordedMessage {
  content: string;
  options: unknown;
}

interface RecordedNotification {
  message: string;
  level: string;
}

const SKILLS_DIR = join(repoRoot(import.meta.url), "skills");

function writeSkill(root: string, folder: string, lines: string[]): void {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", ...lines, "---", "", `# ${folder}`, ""].join("\n"), "utf8");
}

function recordingPi() {
  let commands = new Map<string, CommandDefinition>();
  let messages: RecordedMessage[] = [];
  const pi = {
    registerCommand(name: string, definition: CommandDefinition) {
      commands = new Map([...commands, [name, definition]]);
    },
    sendUserMessage(content: string, options?: unknown) {
      messages = [...messages, { content, options }];
    },
  };
  return { pi: pi as never, commands: () => commands, messages: () => messages };
}

function potetoPi() {
  let commands = new Map<string, CommandDefinition>();
  let messages: RecordedMessage[] = [];
  let notifications: RecordedNotification[] = [];
  const pi = {
    on() {},
    registerCommand(name: string, definition: CommandDefinition) {
      commands = new Map([...commands, [name, definition]]);
    },
    appendEntry() {},
    sendUserMessage(content: string, options?: unknown) {
      messages = [...messages, { content, options }];
    },
  };
  const ctx = {
    ui: {
      notify(message: string, level: string) {
        notifications = [...notifications, { message, level }];
      },
      setStatus() {},
    },
  };
  return {
    pi: pi as never,
    ctx,
    commands: () => commands,
    messages: () => messages,
    notifications: () => notifications,
  };
}

test("commands-01 expands /skill:<name> arguments into the skill prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-skill-command-"));
  try {
    writeSkill(root, "demo-skill", [
      "name: demo-skill",
      "description: Demo skill for the contract test.",
    ]);
    const env = recordingPi();
    registerSkillCommands(env.pi, { skillsDir: root });
    const command = env.commands().get("demo-skill");
    expect(command?.description).toBe("Demo skill for the contract test.");

    await command?.handler("  extra args  ", {});
    expect(env.messages()).toEqual([
      { content: "/skill:demo-skill extra args", options: { expandPromptTemplates: true, deliverAs: "followUp" } },
    ]);

    await command?.handler("", {});
    expect(env.messages().at(-1)).toEqual({
      content: "/skill:demo-skill",
      options: { expandPromptTemplates: true, deliverAs: "followUp" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const shipped = recordingPi();
  registerSkillCommands(shipped.pi);
  await shipped.commands().get("how")?.handler("why does this exist", {});
  expect(shipped.messages()).toEqual([
    { content: "/skill:how why does this exist", options: { expandPromptTemplates: true, deliverAs: "followUp" } },
  ]);
});

test("commands-04 parses kebab-case names, keeps disable-model-invocation, and ignores Cursor-only fields", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-skill-frontmatter-"));
  try {
    writeSkill(root, "good-name", [
      "name: good-name",
      "description: Kebab skill for the frontmatter contract.",
      "disable-model-invocation: true",
      "mode: true",
      "icon: crown",
      "color: yellow",
      "reminder: New task? apply /poteto-mode.",
      'paths: ["**/*.ts"]',
      "alwaysApply: true",
    ]);
    expect(readSkillCommands(root)).toEqual([
      { name: "good-name", description: "Kebab skill for the frontmatter contract." },
    ]);

    const shipped = readSkillCommands();
    expect(shipped.length >= 40, `expected the shipped skill corpus, saw ${shipped.length}`).toBeTruthy();
    expect(shipped.filter((skill) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill.name)).map((skill) => skill.name), "every shipped frontmatter name is kebab-case").toEqual([]);
    expect(shipped.filter((skill) => !existsSync(join(SKILLS_DIR, skill.name, "SKILL.md"))).map((skill) => skill.name), "every frontmatter name matches its skill directory").toEqual([]);
    const withoutFlag = shipped.filter(
      (skill) => !readFileSync(join(SKILLS_DIR, skill.name, "SKILL.md"), "utf8").includes("disable-model-invocation: true"),
    );
    // setup-pstack is the Pi-only twin of the excluded Cursor mdc-rules mechanism (spec/mechanisms.tsv).
    expect(withoutFlag.map((skill) => skill.name)).toEqual(["setup-pstack"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commands-05 /pstack aliases /poteto-mode and notifies when run without arguments", async () => {
  const env = potetoPi();
  const runtime = createPotetoRuntime(env.pi, { armReadonly: () => {} });
  const pstack = env.commands().get("pstack");
  const poteto = env.commands().get("poteto-mode");
  expect(pstack?.description).toBe("Alias for /poteto-mode");

  await pstack?.handler("", env.ctx);
  const notices = env.notifications();
  expect(notices.length).toBe(1);
  expect(notices[0].level).toBe("info");
  expect(notices[0].message).toMatch(/pstack_spawn/);
  expect(notices[0].message).toMatch(/pstack_loop/);
  expect(notices[0].message).toMatch(/Readonly: \/pstack-readonly/);
  expect(notices[0].message).toMatch(/Package: /);
  expect(env.messages().length, "no arguments means no forwarded prompt").toBe(0);
  expect(runtime.getState().enabled, "the bare alias still arms poteto mode").toBe(true);

  await poteto?.handler("banana smoothie recipe", env.ctx);
  const fromPoteto = env.messages().at(-1);
  await pstack?.handler("banana smoothie recipe", env.ctx);
  const fromPstack = env.messages().at(-1);
  expect(fromPstack, "alias forwards the same forced skill prompt").toEqual(fromPoteto);
  expect(fromPstack).toEqual({
    content: "/skill:poteto-mode banana smoothie recipe",
    options: { expandPromptTemplates: true, deliverAs: "followUp" },
  });
});
