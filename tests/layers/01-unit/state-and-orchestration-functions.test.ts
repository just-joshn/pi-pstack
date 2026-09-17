import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  READONLY_TOOL_POLICIES,
  createReadonlyRuntime,
} from "../../../extensions/readonly-state/index.ts";
import { createPotetoRuntime } from "../../../extensions/poteto-state/index.ts";
import { loadPlaybookBody } from "../../../extensions/sticky-playbook.ts";
import { registerArena } from "../../../extensions/orchestration/arena.ts";

const READONLY_ENTRY_TYPE = "pstack-session-readonly";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface RecordedStatus {
  id: string;
  value: string | undefined;
}

function readonlyEnv(allTools: string[], activeTools: string[]) {
  const handlers = new Map<string, EventHandler>();
  let statuses: RecordedStatus[] = [];
  let activeWrites: string[][] = [];
  const pi = {
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
    appendEntry() {},
    registerCommand() {},
    getAllTools: () => allTools.map((name) => ({ name })),
    getActiveTools: () => activeTools,
    setActiveTools(tools: string[]) {
      activeWrites = [...activeWrites, tools];
    },
  };
  const ui = {
    setStatus(id: string, value: string | undefined) {
      statuses = [...statuses, { id, value }];
    },
    notify() {},
  };
  return {
    pi,
    ui,
    handler(name: string): EventHandler {
      const found = handlers.get(name);
      if (!found) throw new Error(`${name} handler was not registered`);
      return found;
    },
    statuses: (): RecordedStatus[] => statuses,
    activeWrites: (): string[][] => activeWrites,
  };
}

interface CommandSpec {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function potetoEnv() {
  const commands = new Map<string, CommandSpec>();
  let messages: Array<{ text: string; opts?: unknown }> = [];
  let armed: string[] = [];
  const pi = {
    on() {},
    appendEntry() {},
    registerCommand(name: string, spec: CommandSpec) {
      commands.set(name, spec);
    },
    sendUserMessage(text: string, opts?: unknown) {
      messages = [...messages, { text, opts }];
    },
  };
  const ui = { setStatus() {}, notify() {} };
  const runtime = createPotetoRuntime(pi as never, {
    armReadonly: (_ctx: unknown, reason: string) => {
      armed = [...armed, reason];
    },
  });
  return {
    runtime,
    ui,
    commands,
    armed: (): string[] => armed,
    messages: (): Array<{ text: string; opts?: unknown }> => messages,
  };
}

interface ToolTextPart {
  type: string;
  text: string;
}

interface ArenaProgressUpdate {
  content: ToolTextPart[];
  details: Record<string, unknown>;
}

interface ArenaOutcome {
  content: ToolTextPart[];
  details: { results: Array<{ label: string; cwd: string }> };
}

interface ArenaTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: (update: ArenaProgressUpdate) => void,
    ctx: unknown,
  ) => Promise<ArenaOutcome>;
}

function captureArena(): ArenaTool {
  let captured: ArenaTool | undefined;
  const pi = {
    registerTool(definition: ArenaTool) {
      captured = definition;
    },
  };
  registerArena(pi as never);
  if (!captured) throw new Error("registerArena registered no tool");
  return captured;
}

const STUB_CHILD_SOURCE = [
  'const task = process.argv.at(-1) ?? "";',
  'const text = ["stub-child prompt=" + task, "PASS"].join("\\n");',
  'const message = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };',
  'process.stdout.write(JSON.stringify(message) + "\\n");',
  "",
].join("\n");

function setChildScript(script: string): () => void {
  const saved = process.argv[1];
  process.argv[1] = script;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.argv, 1);
    else process.argv[1] = saved;
  };
}

function writeStubChild(dir: string): string {
  const path = join(dir, "stub-child.mjs");
  writeFileSync(path, STUB_CHILD_SOURCE, "utf8");
  return path;
}

test("readonly deslop and task policies block writes and coerce unread fan-out", () => {
  expect(READONLY_TOOL_POLICIES.pstack_deslop({ applySafe: true })).toEqual({
    action: "block",
    reason: "pstack session readonly: blocked deslop applySafe/autoApply.",
  });
  expect(READONLY_TOOL_POLICIES.pstack_deslop({ autoApply: true })).toEqual({
    action: "block",
    reason: "pstack session readonly: blocked deslop applySafe/autoApply.",
  });
  expect(READONLY_TOOL_POLICIES.pstack_deslop({})).toEqual({ action: "allow" });
  expect(READONLY_TOOL_POLICIES.pstack_task({})).toEqual({ action: "coerceReadonly" });
  expect(READONLY_TOOL_POLICIES.pstack_task({ readonly: true })).toEqual({ action: "allow" });
  expect(READONLY_TOOL_POLICIES.pstack_task({ subagent_type: "investigator" })).toEqual({
    action: "allow",
  });
  expect(READONLY_TOOL_POLICIES.pstack_task({ subagent_type: "comment-sicko" })).toEqual({
    action: "allow",
  });
  expect(READONLY_TOOL_POLICIES.pstack_task({ subagent_type: "poteto-agent" })).toEqual({
    action: "coerceReadonly",
  });
});

test("createReadonlyRuntime restores an armed session from the transcript on session_start", () => {
  const env = readonlyEnv(["read", "write", "bash", "pstack_spawn"], ["read", "write"]);
  const runtime = createReadonlyRuntime(env.pi as never);
  env.handler("session_start")(
    {},
    {
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: READONLY_ENTRY_TYPE,
            data: { enabled: true, reason: "playbook:investigation" },
          },
        ],
      },
      ui: env.ui,
    },
  );
  expect(runtime.getState()).toEqual({
    enabled: true,
    toolsBefore: ["read", "write"],
    reason: "playbook:investigation",
  });
  expect(env.statuses()).toEqual([{ id: "pstack-ro", value: "readonly" }]);
  expect(env.activeWrites()).toEqual([["read", "grep", "find", "ls"]]);
});

test("createReadonlyRuntime takes the last readonly entry and leaves a disabled session inert", () => {
  const env = readonlyEnv(["read", "write"], ["read", "write"]);
  const runtime = createReadonlyRuntime(env.pi as never);
  env.handler("session_start")(
    {},
    {
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: READONLY_ENTRY_TYPE, data: { enabled: true, reason: "command" } },
          { type: "custom", customType: READONLY_ENTRY_TYPE, data: { enabled: false } },
          { type: "assistant", data: {} },
        ],
      },
      ui: env.ui,
    },
  );
  expect(runtime.getState()).toEqual({ enabled: false, toolsBefore: undefined, reason: undefined });
  expect(env.statuses()).toEqual([]);
  expect(env.activeWrites()).toEqual([]);
});

test("releasePlaybookArm disarms a playbook arm and leaves a command arm armed", () => {
  const env = readonlyEnv(["read", "write"], ["read", "write"]);
  const runtime = createReadonlyRuntime(env.pi as never);
  const ctx = { ui: env.ui };
  runtime.setEnabled(true, ctx, "playbook:investigation");
  expect(runtime.getState()).toEqual({
    enabled: true,
    toolsBefore: ["read", "write"],
    reason: "playbook:investigation",
  });
  runtime.releasePlaybookArm(ctx);
  expect(runtime.getState()).toEqual({ enabled: false, toolsBefore: undefined, reason: undefined });

  runtime.setEnabled(true, ctx, "command");
  runtime.releasePlaybookArm(ctx);
  expect(runtime.getState()).toEqual({
    enabled: true,
    toolsBefore: ["read", "write"],
    reason: "command",
  });
});

test("the readonly runtime re-injects the read-only contract only while armed", () => {
  const env = readonlyEnv(["read", "write"], ["read", "write"]);
  const runtime = createReadonlyRuntime(env.pi as never);
  const prompt = env.handler("before_agent_start");
  expect(prompt({ systemPrompt: "BASE" }, {})).toBe(undefined);
  runtime.setEnabled(true, { ui: env.ui }, "command");
  expect(prompt({ systemPrompt: "BASE" }, {})).toEqual({
    systemPrompt:
      "BASE\n\n## pstack session readonly\nThis session is read-only. Do not write, edit, or run bash. Use read/grep/find/ls (and read-safe pstack_* tools). Spawn children with readonly:true or role investigator/comment-sicko. Deliver citations and recommendations only.",
  });
});

test("/poteto-mode with an investigation task arms readonly with the playbook reason", async () => {
  const env = potetoEnv();
  await env.commands.get("poteto-mode")?.handler("investigate why is the build slow", {
    ui: env.ui,
  });
  expect(env.armed()).toEqual(["playbook:investigation"]);
  expect(env.runtime.getState().matchedPlaybookId).toBe("investigation");
  expect(env.runtime.getState().matchedScore).toBe(5);
  expect(env.runtime.getState().enabled).toBe(true);
  expect(env.messages()).toEqual([
    {
      text: "/skill:poteto-mode playbooks/investigation investigate why is the build slow",
      opts: { expandPromptTemplates: true, deliverAs: "followUp" },
    },
  ]);
});

test("loadPlaybookBody strips frontmatter from an explicit playbook path", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-playbook-body-"));
  try {
    const framed = join(dir, "framed.md");
    writeFileSync(framed, "---\nname: framed\n---\nStep one\n\nStep two\n", "utf8");
    expect(loadPlaybookBody(framed)).toBe("Step one\n\nStep two");

    const unterminated = join(dir, "unterminated.md");
    writeFileSync(unterminated, "---\nname: broken\nno closing fence\n", "utf8");
    expect(loadPlaybookBody(unterminated)).toBe("---\nname: broken\nno closing fence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pstack_arena streams candidate progress through onUpdate", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pstack-arena-progress-"));
  const restoreScript = setChildScript(writeStubChild(parent));
  try {
    const dirA = join(parent, "candidate-a");
    const dirB = join(parent, "candidate-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const tool = captureArena();
    let updates: string[] = [];
    const outcome = await tool.execute(
      "t",
      {
        prompt: "Pick a base",
        candidates: [
          { model: "stub/candidate-a", cwd: dirA },
          { model: "stub/candidate-b", cwd: dirB },
        ],
      },
      undefined,
      (update) => {
        updates = [...updates, ...update.content.map((part) => part.text)];
      },
      { cwd: parent, model: { provider: "pstack-test", id: "parent" }, isProjectTrusted: () => true },
    );
    expect(updates).toEqual(["1/2 arena candidates done", "2/2 arena candidates done"]);
    expect(outcome.details.results.length).toBe(2);
    expect(outcome.details.results.map((entry) => entry.cwd).toSorted()).toEqual([dirA, dirB].toSorted());
  } finally {
    restoreScript();
    rmSync(parent, { recursive: true, force: true });
  }
});
