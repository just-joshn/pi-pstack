import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piPstack from "../../../extensions/index.ts";
import {
  readSkillCommands,
  registerPiOnlyCommands,
  registerSkillCommands,
} from "../../../extensions/commands/skill-commands.ts";

interface CommandDefinition {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

type EventHandler = (...args: unknown[]) => unknown;

function writeSkill(root: string, folder: string, lines: string[]): void {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", ...lines, "---", "", `# ${folder}`, ""].join("\n"), "utf8");
}

function recordingPi() {
  let commands = new Map<string, CommandDefinition>();
  let messages: Array<{ content: string; options: unknown }> = [];
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

function fakePstackHost() {
  const tools = new Map<string, { name: string }>();
  const commands = new Map<string, CommandDefinition>();
  let handlers = new Map<string, EventHandler[]>();
  let active = ["read", "grep", "find", "ls", "write", "edit", "bash"];
  let statuses: Array<[string, string | undefined]> = [];
  const api = {
    on(event: string, handler: EventHandler) {
      handlers = new Map([...handlers, [event, [...(handlers.get(event) ?? []), handler]]]);
    },
    registerTool(definition: { name: string }) {
      tools.set(definition.name, definition);
    },
    registerCommand(name: string, spec: CommandDefinition) {
      commands.set(name, spec);
    },
    registerShortcut() {},
    registerFlag() {},
    appendEntry() {},
    getActiveTools() {
      return [...active];
    },
    getAllTools() {
      return [...active, ...tools.keys()].map((name) => ({ name }));
    },
    setActiveTools(next: string[]) {
      active = [...next];
    },
    sendUserMessage() {},
    sendMessage() {},
    exec() {
      return Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false });
    },
  };
  const ctx = {
    ui: {
      setStatus(key: string, value: string | undefined) {
        statuses = [...statuses, [key, value]];
      },
    },
  };
  piPstack(api as never);
  return { tools, commands, handlers: () => handlers, active: () => active, statuses: () => statuses, ctx };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

test("registerPiOnlyCommands forwards the body and trimmed args", async () => {
  const env = recordingPi();
  registerPiOnlyCommands(env.pi, [{ name: "demo", description: "Demo", body: "BODY" }]);
  const command = env.commands().get("demo");
  expect(command?.description).toBe("Demo");
  await command?.handler("  extra  ", {});
  await command?.handler("   ", {});
  expect(env.messages()).toEqual([
    { content: "BODY extra", options: { expandPromptTemplates: true, deliverAs: "followUp" } },
    { content: "BODY", options: { expandPromptTemplates: true, deliverAs: "followUp" } },
  ]);
});

test("readSkillCommands tolerates a missing dir and dedupes names", () => {
  expect(readSkillCommands("/definitely/missing/pstack-skills")).toEqual([]);
  const root = mkdtempSync(join(tmpdir(), "pstack-cmd-list-"));
  try {
    writeSkill(root, "first", ["name: dup", "description: First."]);
    writeSkill(root, "second", ["name: dup", "description: Second."]);
    writeSkill(root, "nameless", ["description: No name."]);
    mkdirSync(join(root, "no-file"), { recursive: true });
    expect(readSkillCommands(root)).toEqual([{ name: "dup", description: "First." }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registerSkillCommands skips reserved and shadowed names", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-cmd-skip-"));
  try {
    writeSkill(root, "reserved-one", ["name: reserved-one", "description: Reserved."]);
    writeSkill(root, "shadow-one", ["name: shadow-one", "description: Shadowed."]);
    writeSkill(root, "kept", ["name: kept", "description: Kept."]);
    let names: string[] = [];
    const pi = {
      registerCommand(name: string) {
        names = [...names, name];
      },
      sendUserMessage() {},
    };
    registerSkillCommands(pi as never, { skillsDir: root, reserved: ["reserved-one"], shadowed: ["shadow-one"] });
    expect(names).toEqual(["kept"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a skill command renders chrome only when the host exposes a status line", async () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-cmd-chrome-"));
  try {
    writeSkill(root, "demo", [
      "name: demo",
      "description: Demo chrome.",
      "icon: crown",
      "color: yellow",
    ]);
    const commands = new Map<string, CommandDefinition>();
    const pi = {
      registerCommand(name: string, spec: CommandDefinition) {
        commands.set(name, spec);
      },
      sendUserMessage() {},
    };
    registerSkillCommands(pi as never, { skillsDir: root });
    let statuses: Array<[string, string | undefined]> = [];
    const themed = {
      ui: {
        setStatus: (key: string, value: string | undefined) => {
          statuses = [...statuses, [key, value]];
        },
        theme: { fg: (token: string, text: string) => `[${token}]${text}` },
      },
    };
    const plain = {
      ui: {
        setStatus: (key: string, value: string | undefined) => {
          statuses = [...statuses, [key, value]];
        },
      },
    };
    await commands.get("demo")?.handler("", themed);
    await commands.get("demo")?.handler("", plain);
    await commands.get("demo")?.handler("", {});
    expect(statuses).toEqual([
      ["pstack-skill", "[warning]crown demo"],
      ["pstack-skill", "crown demo"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("piPstack registers the command, tool, and input-hook surface", () => {
  const host = fakePstackHost();
  expect(host.commands.has("pstack-readonly")).toBe(true);
  expect(host.commands.has("poteto-mode")).toBe(true);
  expect(host.tools.has("pstack_spawn")).toBe(true);
  expect(host.tools.has("pstack_benny_wake")).toBe(true);
  expect(host.tools.has("pstack_ship")).toBe(true);
  expect(host.tools.size >= 17).toBe(true);
  expect(host.handlers().has("input")).toBe(true);
  expect(host.handlers().has("session_shutdown")).toBe(true);
});

test("the composition root arms and releases session readonly from the sticky playbook", async () => {
  const saved = process.env.PSTACK_CHILD_ROLE;
  Reflect.deleteProperty(process.env, "PSTACK_CHILD_ROLE");
  try {
    const host = fakePstackHost();
    await host.commands.get("poteto-mode")?.handler("why was this built", host.ctx);
    expect(host.active().includes("write")).toBe(false);
    expect(host.active().includes("edit")).toBe(false);
    expect(host.statuses().at(-1)).toEqual(["pstack-ro", "readonly"]);
    const input = host.handlers().get("input")?.at(-1);
    input?.({ source: "interactive", text: "reproduce the bug fix root cause" }, host.ctx);
    expect(host.active().includes("write")).toBe(true);
    expect(host.statuses().at(-1)).toEqual(["pstack-ro", undefined]);
  } finally {
    restoreEnv("PSTACK_CHILD_ROLE", saved);
  }
});
