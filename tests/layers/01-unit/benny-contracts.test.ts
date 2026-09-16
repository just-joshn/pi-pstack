import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";

const ORIGINAL_HOME = process.env.HOME;
const TEMP_HOME = mkdtempSync(join(tmpdir(), "pstack-benny-home-"));
process.env.HOME = TEMP_HOME;

const { registerBenny } = await import("../../../extensions/benny/index.ts");
const { registerHeartbeat } = await import("../../../extensions/heartbeat/index.ts");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WAKE_DIR = join(TEMP_HOME, ".pi", "agent");
const WAKE_FILE = join(WAKE_DIR, "pstack-benny-wakes.jsonl");

const POLL_SCRIPT = `
const fs = require("node:fs");
const file = process.argv[1];
const deadline = Date.now() + 20000;
const timer = setInterval(() => {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    raw = "";
  }
  if (raw.length > 0) {
    clearInterval(timer);
    process.stdout.write(raw);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    clearInterval(timer);
    process.exit(7);
  }
}, 25);
`;

type Schema = Parameters<typeof Check>[0];
type ExecOptions = { signal?: AbortSignal | null; timeout?: number; cwd?: string };
type ExecResult = { code: number; stdout: string; stderr: string };
type ExecHandler = (command: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;
type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};
type CapturedTool = {
  name: string;
  parameters: Schema;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResult>;
};
type CapturedCommand = {
  name: string;
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};

after(() => {
  if (ORIGINAL_HOME) process.env.HOME = ORIGINAL_HOME;
  rmSync(TEMP_HOME, { recursive: true, force: true });
});

function resetWakes(): void {
  mkdirSync(WAKE_DIR, { recursive: true });
  writeFileSync(WAKE_FILE, "", "utf8");
}

type WakeRow = { ts: string; intent: string; payload: unknown };

function readWakeRows(): WakeRow[] {
  return readFileSync(WAKE_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WakeRow);
}

function realExec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = stdout + String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = stderr + String(chunk);
    });
    child.on("close", (code: number | null) => {
      resolveResult({ code: code ?? 0, stdout, stderr });
    });
    opts?.signal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  });
}

function fakeEnv(execHandler: ExecHandler = async () => ({ code: 0, stdout: "", stderr: "" })) {
  let tools: CapturedTool[] = [];
  let commands: CapturedCommand[] = [];
  let messages: Array<{ text: string; options: unknown }> = [];
  let notifications: Array<{ message: string; level: string }> = [];
  const pi = {
    registerTool(definition: CapturedTool) {
      tools = [...tools, definition];
    },
    registerCommand(name: string, definition: Omit<CapturedCommand, "name">) {
      commands = [...commands, { name, ...definition }];
    },
    on() {},
    exec: execHandler,
    sendUserMessage(text: string, options?: unknown) {
      messages = [...messages, { text, options }];
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
    pi,
    ctx,
    tool(name: string) {
      const found = tools.find((candidate) => candidate.name === name);
      assert.ok(found, `${name} is registered`);
      return found;
    },
    command(name: string) {
      const found = commands.find((candidate) => candidate.name === name);
      assert.ok(found, `${name} is registered`);
      return found;
    },
    messages: () => messages,
    notifications: () => notifications,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("timed out waiting for the loop watcher to fire");
}

test("benny-01 dispatches path, append, and drain actions", async () => {
  resetWakes();
  const env = fakeEnv();
  registerBenny(env.pi as never);
  const wake = env.tool("pstack_benny_wake");

  const pathResult = await wake.execute("t", { action: "path" });
  assert.equal(pathResult.content[0].text, WAKE_FILE);
  assert.equal(pathResult.details.path, WAKE_FILE);

  const appendResult = await wake.execute("t", { action: "append", payload: '{"issue":"x"}' });
  assert.equal(appendResult.details.ok, true);
  assert.equal(appendResult.content[0].text, `Appended wake to ${WAKE_FILE}`);
  assert.equal(readWakeRows().length, 1);

  const unchanged = await wake.execute("t", { action: "path" });
  assert.equal(unchanged.details.path, WAKE_FILE);
  assert.equal(readWakeRows().length, 1, "path does not drain the queue");

  const drainResult = await wake.execute("t", { action: "drain" });
  assert.equal(drainResult.details.count, 1);
  assert.equal(readWakeRows().length, 0);

  assert.equal(Check(wake.parameters, { action: "drain" }), true);
  assert.equal(Check(wake.parameters, { action: "purge" }), false);
  assert.equal(Check(wake.parameters, {}), false);
});

test("benny-02 appends a JSONL payload line with ts and intent", async () => {
  resetWakes();
  const env = fakeEnv();
  registerBenny(env.pi as never);
  const wake = env.tool("pstack_benny_wake");

  await wake.execute("t", { action: "append", payload: '{"issue":"abc"}', intent: "repro" });
  await wake.execute("t", { action: "append", payload: '{"issue":"def"}', intent: "triage" });

  const rows = readWakeRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]), ["ts", "intent", "payload"]);
  assert.equal(rows[0].intent, "repro");
  assert.deepEqual(rows[0].payload, { issue: "abc" });
  assert.equal(new Date(rows[0].ts).toISOString(), rows[0].ts);
  assert.equal(rows[1].intent, "triage");
  assert.deepEqual(rows[1].payload, { issue: "def" });
  assert.equal(readFileSync(WAKE_FILE, "utf8").endsWith("\n"), true);
});

test("benny-03 drain returns pending lines and truncates the file", async () => {
  resetWakes();
  const env = fakeEnv();
  registerBenny(env.pi as never);
  const wake = env.tool("pstack_benny_wake");

  await wake.execute("t", { action: "append", payload: '{"n":1}' });
  await wake.execute("t", { action: "append", payload: '{"n":2}' });
  const pending = readFileSync(WAKE_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const drained = await wake.execute("t", { action: "drain" });
  assert.equal(drained.details.count, 2);
  assert.equal(drained.content[0].text, `Drained 2 wake(s):\n${pending.join("\n")}`);
  assert.equal(readFileSync(WAKE_FILE, "utf8"), "");

  const empty = await wake.execute("t", { action: "drain" });
  assert.equal(empty.details.count, 0);
  assert.equal(empty.content[0].text, "No pending Benny wakes.");
});

test("benny-04 setup-benny sends the skill path to read and follow", async () => {
  const env = fakeEnv();
  registerBenny(env.pi as never);
  const skill = resolve(REPO_ROOT, "automations/benny/skills/setup-benny/SKILL.md");
  assert.equal(existsSync(skill), true);

  await env.command("setup-benny").handler("", env.ctx);

  const sent = env.messages()[0];
  assert.equal(sent.text.startsWith("Read and follow "), true);
  assert.equal(sent.text.includes(skill), true);
  assert.deepEqual(sent.options, { expandPromptTemplates: false, deliverAs: "followUp" });
  assert.deepEqual(env.notifications(), []);
});

test("benny-05 benny-triage sends the triage skill path for immediate evaluation", async () => {
  const env = fakeEnv();
  registerBenny(env.pi as never);
  const skill = resolve(REPO_ROOT, "automations/benny/skills/triage-issue-reports/SKILL.md");
  assert.equal(existsSync(skill), true);
  const handler = env.command("benny-triage").handler;

  await handler("staging 500s", env.ctx);
  await handler("", env.ctx);

  assert.equal(env.messages()[0].text.startsWith(`Read and follow ${skill}.`), true);
  assert.equal(env.messages()[0].text.includes("Context: staging 500s"), true);
  assert.equal(
    env.messages()[1].text.includes("Await the next Slack/tracker issue payload"),
    true,
  );
  assert.deepEqual(
    env.messages().map((message) => message.options),
    [
      { expandPromptTemplates: false, deliverAs: "followUp" },
      { expandPromptTemplates: false, deliverAs: "followUp" },
    ],
  );
});

test("benny-06 benny-repro sends the repro skill path with the issue context", async () => {
  const env = fakeEnv();
  registerBenny(env.pi as never);
  const skill = resolve(REPO_ROOT, "automations/benny/skills/reproduce-and-fix-issues/SKILL.md");
  assert.equal(existsSync(skill), true);
  const handler = env.command("benny-repro").handler;

  await handler("issue 42 crashes on startup", env.ctx);
  await handler("", env.ctx);

  assert.equal(env.messages()[0].text.startsWith(`Read and follow ${skill}.`), true);
  assert.equal(env.messages()[0].text.includes("Issue: issue 42 crashes on startup"), true);
  assert.equal(env.messages()[0].text.includes("pstack_control_cli"), true);
  assert.equal(env.messages()[1].text.includes("Issue:"), false);
});

test("benny-07 a wake payload drives the pstack_loop watcher", async () => {
  resetWakes();
  const env = fakeEnv(realExec);
  registerBenny(env.pi as never);
  registerHeartbeat(env.pi as never);
  const wake = env.tool("pstack_benny_wake");
  const loop = env.tool("pstack_loop");

  const armed = await loop.execute(
    "t",
    {
      action: "arm",
      mode: "watcher",
      prompt: "triage the wake payload",
      watchArgv: ["node", "-e", POLL_SCRIPT, WAKE_FILE],
    },
    undefined,
    undefined,
    env.ctx,
  );
  assert.equal(armed.details.mode, "watcher");

  const appended = await wake.execute("t", {
    action: "append",
    payload: '{"issue":"wake-7"}',
    intent: "triage",
  });
  assert.equal(appended.details.ok, true);

  try {
    await waitFor(() => env.messages().some((message) => message.text.includes("reason=watcher]")));
  } finally {
    await loop.execute("t", { action: "stop" }, undefined, undefined, env.ctx);
  }

  const fired = env.messages().find((message) => message.text.includes("reason=watcher]"));
  assert.ok(fired);
  assert.equal(fired.text.includes("triage the wake payload"), true);
  assert.equal(fired.text.includes("wake-7"), true);
  assert.deepEqual(fired.options, { deliverAs: "followUp" });
  assert.equal(readWakeRows().length, 1, "the watcher does not consume the queue");
});

test("benny-08 parses the payload as JSON when possible and keeps raw strings otherwise", async () => {
  resetWakes();
  const env = fakeEnv();
  registerBenny(env.pi as never);
  const wake = env.tool("pstack_benny_wake");

  await wake.execute("t", { action: "append", payload: '{"nested":{"ok":true}}' });
  await wake.execute("t", { action: "append", payload: "not json {" });
  await wake.execute("t", { action: "append", payload: "42" });

  const rows = readWakeRows();
  assert.deepEqual(rows[0].payload, { nested: { ok: true } });
  assert.equal(rows[1].payload, "not json {");
  assert.equal(rows[2].payload, 42);

  await assert.rejects(
    () => wake.execute("t", { action: "append", payload: "   " }),
    /pstack_benny_wake append requires a non-empty payload JSON string/,
  );
  assert.equal(readWakeRows().length, 3);
});

test("benny-09 defaults the intent parameter to triage", async () => {
  resetWakes();
  const env = fakeEnv();
  registerBenny(env.pi as never);
  const wake = env.tool("pstack_benny_wake");

  await wake.execute("t", { action: "append", payload: '{"a":1}' });
  await wake.execute("t", { action: "append", payload: '{"a":2}', intent: "repro" });

  const rows = readWakeRows();
  assert.equal(rows[0].intent, "triage");
  assert.equal(rows[1].intent, "repro");
  assert.equal(Check(wake.parameters, { action: "append", payload: "{}" }), true);
  assert.equal(Check(wake.parameters, { action: "append", payload: "{}", intent: "other" }), false);
});

test("benny-10 resolves the wake file under the Pi agent directory", async () => {
  resetWakes();
  const env = fakeEnv();
  registerBenny(env.pi as never);
  const wake = env.tool("pstack_benny_wake");

  const result = await wake.execute("t", { action: "path" });
  const wakePath = String(result.details.path);
  assert.equal(wakePath, WAKE_FILE);
  assert.equal(wakePath, resolve(TEMP_HOME, ".pi/agent/pstack-benny-wakes.jsonl"));
  assert.equal(wakePath, join(homedir(), ".pi", "agent", "pstack-benny-wakes.jsonl"));
  assert.equal(basename(wakePath), "pstack-benny-wakes.jsonl");
  assert.equal(wakePath.startsWith(join(TEMP_HOME, ".pi", "agent")), true);

  await wake.execute("t", { action: "append", payload: '{"p":1}' });
  assert.equal(readFileSync(wakePath, "utf8").includes('"p":1'), true);
});
