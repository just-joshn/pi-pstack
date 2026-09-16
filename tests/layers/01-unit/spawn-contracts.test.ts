import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Value } from "typebox/value";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PARENT_MODEL = "anthropic/claude-parent-4-5";
const GENERAL_NOTE =
  "pstack child: role=general sessionMode=isolated. Extensions/skills discover from Pi defaults; conversation history is not inherited.";
const SICKO_PROMPT = [
  "You are Comment Sicko. Follow agents/comment-sicko.md rules.",
  "First output exactly: Yes... Ha ha ha... Yes!",
  "You are readonly: report only; do not write, edit, or run bash.",
  "RAW BRIEF",
].join("\n\n");
const INVESTIGATOR_PROMPT = [
  "You are a read-only investigator. Do not write, edit, or mutate the tree.",
  "Cite files and evidence. Return findings only.",
  "RAW BRIEF",
].join("\n\n");

interface RecordedSpawn {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  killSignals: string[];
}

interface SpawnPlan {
  stdout: string;
  exitCode: number;
  closes: boolean;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: (signal?: string) => boolean;
}

let spawnPlan: SpawnPlan = { stdout: "", exitCode: 0, closes: true };
let recordedSpawns: RecordedSpawn[] = [];

function setSpawnPlan(plan: Partial<SpawnPlan>): void {
  spawnPlan = { stdout: "", exitCode: 0, closes: true, ...plan };
}

function messageLine(text: string): string {
  const event = {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
  return `${JSON.stringify(event)}\n`;
}

function makeFakeChild(plan: SpawnPlan, record: RecordedSpawn): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = (signal?: string) => {
    record.killSignals = [...record.killSignals, signal ?? "SIGTERM"];
    return true;
  };
  setImmediate(() => {
    if (plan.stdout) child.stdout.emit("data", Buffer.from(plan.stdout, "utf8"));
    if (plan.closes) child.emit("close", plan.exitCode);
  });
  return child;
}

function fakeSpawn(
  _command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
): FakeChild {
  const record: RecordedSpawn = {
    args: [...args],
    cwd: options.cwd ?? "",
    env: options.env ?? {},
    killSignals: [],
  };
  recordedSpawns = [...recordedSpawns, record];
  return makeFakeChild(spawnPlan, record);
}

const nodeRequire = createRequire(import.meta.url);
const childProcessModule = nodeRequire("node:child_process") as { spawn: unknown };
childProcessModule.spawn = fakeSpawn as unknown;

const childProcessEsm = await import("node:child_process");
if (childProcessEsm.spawn !== (fakeSpawn as unknown)) {
  throw new Error("fake spawn did not reach the child_process ESM facade; refusing to run");
}

const childRunner = await import("../../../extensions/subagents/child-runner.ts");
const subagents = await import("../../../extensions/subagents/index.ts");
const modelsConfig = await import("../../../extensions/models/config.ts");

interface ToolUpdate {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface ToolReply {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  parameters: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
    ctx?: unknown,
  ) => Promise<ToolReply>;
}

interface FollowUpCall {
  text: string;
  options: Record<string, unknown>;
}

interface Harness {
  ctx: { model: { provider: string; id: string }; cwd: string };
  tool: (name: string) => CapturedTool;
  shutdown: () => void;
  followUps: FollowUpCall[];
}

function makeHarness(cwd: string): Harness {
  const tools = new Map<string, CapturedTool>();
  const listeners = new Map<string, () => void>();
  let followUps: FollowUpCall[] = [];
  const pi = {
    on(event: string, handler: () => void) {
      listeners.set(event, handler);
    },
    registerTool(definition: CapturedTool) {
      tools.set(definition.name, definition);
    },
    getActiveTools() {
      return [] as string[];
    },
    sendUserMessage(text: string, options: Record<string, unknown>) {
      followUps = [...followUps, { text, options }];
    },
  };
  subagents.registerSpawn(pi as never);
  return {
    ctx: { model: { provider: "anthropic", id: "claude-parent-4-5" }, cwd, isProjectTrusted: () => true },
    tool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool;
    },
    shutdown() {
      const handler = listeners.get("session_shutdown");
      if (!handler) throw new Error("session_shutdown handler not registered");
      handler();
    },
    get followUps() {
      return followUps;
    },
  };
}

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "pstack-spawn-contracts-"));
}

function runSpawn(
  h: Harness,
  params: Record<string, unknown>,
  onUpdate?: (update: ToolUpdate) => void,
): Promise<ToolReply> {
  return h.tool("pstack_spawn").execute("call-spawn", params, undefined, onUpdate, h.ctx);
}

async function spawnArgs(h: Harness, params: Record<string, unknown>): Promise<string[]> {
  setSpawnPlan({ stdout: messageLine("ack") });
  await runSpawn(h, { background: false, ...params });
  return lastSpawn().args;
}

function lastSpawn(): RecordedSpawn {
  const record = recordedSpawns.at(-1);
  if (!record) throw new Error("no child process was spawned");
  return record;
}

function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function makeUpdates(): { messages: string[]; record: (update: ToolUpdate) => void } {
  let messages: string[] = [];
  return {
    get messages() {
      return messages;
    },
    record(update: ToolUpdate) {
      messages = [...messages, ...update.content.map((part) => part.text)];
    },
  };
}

async function awaitFollowUp(h: Harness, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = h.followUps.at(-1);
    if (call) return call.text;
    await delay(10);
  }
  throw new Error("background completion follow-up was not delivered");
}

async function runWithTimerCapture<T>(run: () => Promise<T>): Promise<number[]> {
  const realSetTimeout = globalThis.setTimeout;
  let delays: number[] = [];
  const proxy = ((handler: (...args: unknown[]) => void, timeout?: number, ...rest: unknown[]) => {
    delays = [...delays, timeout ?? 0];
    return realSetTimeout(handler as never, timeout, ...(rest as never[]));
  }) as typeof globalThis.setTimeout;
  globalThis.setTimeout = proxy;
  try {
    await run();
    return delays;
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test("spawn-02 rejects a spawn call with no task and requires the task string", () => {
  const cwd = tempCwd();
  try {
    const h = makeHarness(cwd);
    const schema = h.tool("pstack_spawn").parameters;
    assert.equal(Value.Check(schema, { task: "self-contained brief" }), true);
    assert.equal(Value.Check(schema, { task: "self-contained brief", role: "general", timeoutMs: 1000 }), true);
    assert.equal(Value.Check(schema, {}), false);
    assert.equal(Value.Check(schema, { role: "general" }), false);
    assert.equal(Value.Check(schema, { task: 42 }), false);
    assert.equal(Value.Check(schema, { task: "" }), false, "an empty brief is not a task");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn-03 defaults the role to general and wraps per-role prompts", async () => {
  const cwd = tempCwd();
  try {
    childRunner.__resetBackgroundJobsForTests();
    const h = makeHarness(cwd);
    const generalArgs = await spawnArgs(h, { task: "RAW BRIEF" });
    assert.equal(generalArgs.at(-1), "RAW BRIEF");
    assert.equal(lastSpawn().env.PSTACK_CHILD_ROLE, "general");
    assert.equal(argAfter(generalArgs, "--append-system-prompt"), GENERAL_NOTE);
    assert.equal((await spawnArgs(h, { task: "RAW BRIEF", role: "general" })).at(-1), "RAW BRIEF");
    const potetoArgs = await spawnArgs(h, { task: "RAW BRIEF", role: "poteto-agent" });
    assert.equal(potetoArgs.at(-1), "/skill:poteto-mode RAW BRIEF");
    assert.equal(argAfter(potetoArgs, "--skill"), resolve(REPO_ROOT, "skills", "poteto-mode", "SKILL.md"));
    const sickoArgs = await spawnArgs(h, { task: "RAW BRIEF", role: "comment-sicko" });
    assert.equal(sickoArgs.at(-1), SICKO_PROMPT);
    assert.equal(argAfter(sickoArgs, "--tools"), "read,grep,find,ls");
    const investigatorArgs = await spawnArgs(h, { task: "RAW BRIEF", role: "investigator" });
    assert.equal(investigatorArgs.at(-1), INVESTIGATOR_PROMPT);
    assert.equal(lastSpawn().env.PSTACK_CHILD_ROLE, "investigator");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn-04 refuses a bare marketing slug and accepts provider/id, inherit-parent, and auto", async () => {
  assert.deepEqual(modelsConfig.normalizeModelSelector("anthropic/claude-sonnet-4-5", PARENT_MODEL), {
    ok: true,
    model: "anthropic/claude-sonnet-4-5",
  });
  assert.deepEqual(modelsConfig.normalizeModelSelector("inherit-parent", PARENT_MODEL), { ok: true, model: PARENT_MODEL });
  assert.deepEqual(modelsConfig.normalizeModelSelector("auto", PARENT_MODEL), { ok: true, model: PARENT_MODEL });
  assert.deepEqual(modelsConfig.normalizeModelSelector("grok-4.6-fast-xhigh", PARENT_MODEL), {
    ok: true,
    model: "xai/grok-4",
    mappedFrom: "grok-4.6-fast-xhigh",
  });
  const refused = modelsConfig.normalizeModelSelector("unmapped-bare-slug", PARENT_MODEL, { allowFallbackToParent: false });
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /Refused bare model slug 'unmapped-bare-slug'/);

  const cwd = tempCwd();
  try {
    childRunner.__resetBackgroundJobsForTests();
    const h = makeHarness(cwd);
    const before = recordedSpawns.length;
    await assert.rejects(
      runSpawn(h, { task: "brief", model: "unmapped-bare-slug", background: false }),
      /Refused bare model slug 'unmapped-bare-slug'/,
    );
    assert.equal(recordedSpawns.length, before);
    const providerArgs = await spawnArgs(h, { task: "brief", model: "anthropic/claude-sonnet-4-5" });
    assert.equal(argAfter(providerArgs, "--model"), "anthropic/claude-sonnet-4-5");
    assert.equal(argAfter(await spawnArgs(h, { task: "brief", model: "inherit-parent" }), "--model"), PARENT_MODEL);
    assert.equal(argAfter(await spawnArgs(h, { task: "brief", model: "auto" }), "--model"), PARENT_MODEL);
    assert.equal(argAfter(await spawnArgs(h, { task: "brief", model: "grok-4.6-fast-xhigh" }), "--model"), "xai/grok-4");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn-05 resolves an omitted model from role config over the parent model", async () => {
  const cwd = tempCwd();
  try {
    childRunner.__resetBackgroundJobsForTests();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "pstack-models.json"),
      JSON.stringify({ version: 1, roles: { "contracts-role": "anthropic/configured-child" } }),
      "utf8",
    );
    const h = makeHarness(cwd);
    setSpawnPlan({ stdout: messageLine("configured") });
    const configured = await runSpawn(h, { task: "brief", role: "contracts-role", background: false });
    assert.equal(argAfter(lastSpawn().args, "--model"), "anthropic/configured-child");
    const configuredResult = configured.details.result as Record<string, unknown>;
    assert.equal(configuredResult.model, "anthropic/configured-child");
    assert.equal(configured.content[0].text.startsWith("### pstack_spawn (contracts-role, anthropic/configured-child, exit 0"), true);

    setSpawnPlan({ stdout: messageLine("parent") });
    const fallback = await runSpawn(h, { task: "brief", role: "contracts-unconfigured", background: false });
    assert.equal(argAfter(lastSpawn().args, "--model"), PARENT_MODEL);
    const fallbackResult = fallback.details.result as Record<string, unknown>;
    assert.equal(fallbackResult.model, PARENT_MODEL);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn-09 accepts isolated or ephemeral and defaults an unknown sessionMode to isolated", async () => {
  const cwd = tempCwd();
  const previousSessionEnv = process.env.PSTACK_CHILD_SESSION;
  Reflect.deleteProperty(process.env, "PSTACK_CHILD_SESSION");
  try {
    childRunner.__resetBackgroundJobsForTests();
    const h = makeHarness(cwd);
    setSpawnPlan({ stdout: messageLine("iso") });
    const isolated = await runSpawn(h, { task: "brief", sessionMode: "isolated", background: false });
    const isolatedArgs = lastSpawn().args;
    assert.equal(isolatedArgs.includes("--no-session"), false);
    assert.equal(isolatedArgs.includes("--continue"), false);
    const isolatedDir = argAfter(isolatedArgs, "--session-dir");
    assert.equal(isolatedDir?.startsWith(join(cwd, ".pi", "pstack-child-sessions")), true);
    assert.equal(isolated.details.sessionDir, isolatedDir);
    const isolatedResult = isolated.details.result as Record<string, unknown>;
    assert.equal(isolatedResult.sessionDir, isolatedDir);

    setSpawnPlan({ stdout: messageLine("eph") });
    const ephemeral = await runSpawn(h, { task: "brief", sessionMode: "ephemeral", background: false });
    assert.equal(lastSpawn().args.includes("--no-session"), true);
    assert.equal(lastSpawn().args.includes("--session-dir"), false);
    assert.equal(ephemeral.details.sessionDir, undefined);

    setSpawnPlan({ stdout: messageLine("bogus") });
    await runSpawn(h, { task: "brief", sessionMode: "bogus", background: false });
    assert.equal(lastSpawn().args.includes("--no-session"), false);
    assert.equal(lastSpawn().args.includes("--session-dir"), true);

    setSpawnPlan({ stdout: messageLine("unset") });
    await runSpawn(h, { task: "brief", background: false });
    assert.equal(lastSpawn().args.includes("--no-session"), false);
    assert.equal(lastSpawn().args.includes("--session-dir"), true);
  } finally {
    if (previousSessionEnv === undefined) Reflect.deleteProperty(process.env, "PSTACK_CHILD_SESSION");
    else process.env.PSTACK_CHILD_SESSION = previousSessionEnv;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn-12 bounds timeoutMs to 1000..1800000 and defaults to 600000", async () => {
  const cwd = tempCwd();
  try {
    childRunner.__resetBackgroundJobsForTests();
    const h = makeHarness(cwd);
    const schema = h.tool("pstack_spawn").parameters;
    assert.equal(Value.Check(schema, { task: "brief", timeoutMs: 1000 }), true);
    assert.equal(Value.Check(schema, { task: "brief", timeoutMs: 1_800_000 }), true);
    assert.equal(Value.Check(schema, { task: "brief", timeoutMs: 999 }), false);
    assert.equal(Value.Check(schema, { task: "brief", timeoutMs: 1_800_001 }), false);
    assert.equal(childRunner.DEFAULT_TIMEOUT_MS, 600_000);
    assert.equal(childRunner.MAX_TIMEOUT_MS, 1_800_000);
    setSpawnPlan({ stdout: messageLine("ack") });
    const defaulted = await runWithTimerCapture(() => runSpawn(h, { task: "brief", background: false }));
    assert.equal(defaulted.includes(600_000), true);
    const explicit = await runWithTimerCapture(() =>
      runSpawn(h, { task: "brief", timeoutMs: 1000, background: false }),
    );
    assert.equal(explicit.includes(1000), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn-14 exports PSTACK_PARENT_MODEL and PSTACK_CHILD_ROLE to the child env", async () => {
  const cwd = tempCwd();
  const previousProbe = process.env.PSTACK_CONTRACTS_PROBE;
  process.env.PSTACK_CONTRACTS_PROBE = "probe-value";
  try {
    childRunner.__resetBackgroundJobsForTests();
    const h = makeHarness(cwd);
    setSpawnPlan({ stdout: messageLine("ack") });
    await runSpawn(h, { task: "brief", role: "investigator", background: false });
    assert.equal(lastSpawn().env.PSTACK_PARENT_MODEL, PARENT_MODEL);
    assert.equal(lastSpawn().env.PSTACK_CHILD_ROLE, "investigator");
    assert.equal(lastSpawn().env.PSTACK_CONTRACTS_PROBE, "probe-value");
    await runSpawn(h, { task: "brief", background: false });
    assert.equal(lastSpawn().env.PSTACK_PARENT_MODEL, PARENT_MODEL);
    assert.equal(lastSpawn().env.PSTACK_CHILD_ROLE, "general");
  } finally {
    if (previousProbe === undefined) Reflect.deleteProperty(process.env, "PSTACK_CONTRACTS_PROBE");
    else process.env.PSTACK_CONTRACTS_PROBE = previousProbe;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn-15 never inherits the parent conversation history", async () => {
  const cwd = tempCwd();
  try {
    childRunner.__resetBackgroundJobsForTests();
    const h = makeHarness(cwd);
    setSpawnPlan({ stdout: messageLine("fresh") });
    await runSpawn(h, { task: "brief", background: false });
    const fresh = lastSpawn();
    assert.equal(fresh.args.includes("--continue"), false);
    assert.equal(fresh.args.includes("-c"), false);
    assert.equal(fresh.args.includes("--resume"), false);
    assert.equal(fresh.args.includes("-r"), false);
    assert.equal(childRunner.argvHasContinueSemantics(fresh.args), false);
    assert.equal(childRunner.argvIsDirOnlyResume(fresh.args), true);
    assert.equal(argAfter(fresh.args, "--session-dir")?.startsWith(join(cwd, ".pi", "pstack-child-sessions")), true);
    assert.deepEqual(fresh.args.filter((arg) => arg.includes(".jsonl")), []);
    assert.equal(fresh.env.PSTACK_PARENT_SESSION, undefined);
    assert.equal(fresh.env.PSTACK_PARENT_TRANSCRIPT, undefined);

    const priorDir = join(cwd, "prior-child-session");
    mkdirSync(priorDir, { recursive: true });
    setSpawnPlan({ stdout: messageLine("resumed") });
    await runSpawn(h, { task: "brief", resumeSessionDir: priorDir, background: false });
    assert.equal(childRunner.argvHasContinueSemantics(lastSpawn().args), true);
    assert.equal(argAfter(lastSpawn().args, "--session-dir"), priorDir);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn-16 never inherits the parent MCP bindings", async () => {
  const cwd = tempCwd();
  try {
    childRunner.__resetBackgroundJobsForTests();
    const h = makeHarness(cwd);
    setSpawnPlan({ stdout: messageLine("mcp") });
    await runSpawn(h, { task: "brief", background: false });
    const spawned = lastSpawn();
    const mcpFlags = spawned.args.filter((arg) => arg.startsWith("--mcp") || arg === "--extension");
    assert.deepEqual(mcpFlags, []);
    const parentMcpKeys = Object.keys(process.env)
      .filter((key) => /mcp/i.test(key))
      .toSorted();
    const childMcpKeys = Object.keys(spawned.env)
      .filter((key) => /mcp/i.test(key))
      .toSorted();
    assert.deepEqual(childMcpKeys, parentMcpKeys);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn-18 delivers the background follow-up with job id, role, model, exit code, and sessionDir", async () => {
  const cwd = tempCwd();
  try {
    childRunner.__resetBackgroundJobsForTests();
    const h = makeHarness(cwd);
    setSpawnPlan({ stdout: messageLine("child says hi") });
    const started = await runSpawn(h, {
      task: "brief",
      role: "general",
      model: "test/probe-model",
      background: true,
    });
    const jobId = started.details.jobId as string;
    assert.match(jobId, /^bg-1-/);
    assert.equal(started.details.background, true);
    const sessionDir = started.details.sessionDir as string;
    assert.equal(sessionDir.startsWith(join(cwd, ".pi", "pstack-child-sessions")), true);
    const followUp = await awaitFollowUp(h);
    assert.equal(
      followUp,
      `### pstack_spawn background complete (${jobId}, general, test/probe-model, exit 0, status=done, sessionDir=${sessionDir})\n\nchild says hi`,
    );
    assert.equal(h.followUps.at(-1)?.options.deliverAs, "followUp");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn-19 returns the foreground reply with role, model, exit code, and sessionDir", async () => {
  const cwd = tempCwd();
  try {
    childRunner.__resetBackgroundJobsForTests();
    const h = makeHarness(cwd);
    setSpawnPlan({ stdout: messageLine("child says hi") });
    const updates = makeUpdates();
    const reply = await runSpawn(
      h,
      { task: "brief", role: "general", model: "test/probe-model", background: false },
      updates.record,
    );
    const sessionDir = reply.details.sessionDir;
    assert.equal(typeof sessionDir, "string");
    assert.equal(
      reply.content[0].text,
      `### pstack_spawn (general, test/probe-model, exit 0, sessionDir=${sessionDir})\n\nchild says hi`,
    );
    const result = reply.details.result as Record<string, unknown>;
    assert.equal(result.role, "general");
    assert.equal(result.model, "test/probe-model");
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionDir, sessionDir);
    assert.equal(reply.details.readonly, false);
    assert.equal(updates.messages.at(0), "Spawning general on test/probe-model\u2026");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
