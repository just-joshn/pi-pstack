import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHeartbeat } from "../../../extensions/heartbeat/index.ts";

interface ToolParameter {
  type: string;
  minimum?: number;
  maximum?: number;
  items?: { type: string };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: {
    type: string;
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  execute: (
    callId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResult>;
}

interface CommandDefinition {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

interface ExecCall {
  command: string;
  args: string[];
  timeout?: number;
  signal?: AbortSignal;
}

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

function liveList<T>() {
  let items: T[] = [];
  return {
    add: (item: T) => {
      items = [...items, item];
    },
    all: () => items,
  };
}

const defaultExec: ExecFn = async () => ({ code: 0, stdout: "", stderr: "" });
const pendingExec: ExecFn = () => new Promise<never>(() => {});
const flush = () => new Promise((resolve) => setImmediate(resolve));

function createDeferred() {
  let resolve: (value: ExecResult) => void = () => {};
  const promise = new Promise<ExecResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface PiRecorders {
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CommandDefinition>;
  recordHandler: (event: string, handler: () => unknown) => void;
  recordExec: (call: ExecCall) => void;
  recordMessage: (entry: { text: string; opts: unknown }) => void;
  recordSend: (payload: { customType: string; content: string }) => void;
}

function fakePi(execFn: ExecFn, record: PiRecorders) {
  return {
    on: record.recordHandler,
    registerCommand: (name: string, spec: CommandDefinition) => record.commands.set(name, spec),
    registerTool: (spec: ToolDefinition) => record.tools.set(spec.name, spec),
    async exec(command: string, args: string[], opts?: { signal?: AbortSignal; timeout?: number }) {
      record.recordExec({ command, args: [...args], timeout: opts?.timeout, signal: opts?.signal });
      return execFn(command, args);
    },
    sendUserMessage: (text: string, opts?: unknown) => record.recordMessage({ text, opts }),
    sendMessage: record.recordSend,
  };
}

function fakeHeartbeat(execFn: ExecFn = defaultExec) {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  let handlers: Record<string, Array<() => unknown>> = {};
  const execCalls = liveList<ExecCall>();
  const messages = liveList<{ text: string; opts: unknown }>();
  const notices = liveList<{ message: string; level: string }>();
  const statuses = liveList<[string, string | undefined]>();
  const sendMessages = liveList<{ customType: string; content: string }>();
  const recordHandler = (event: string, handler: () => unknown) => {
    handlers = { ...handlers, [event]: [...(handlers[event] ?? []), handler] };
  };
  const pi = fakePi(execFn, {
    tools,
    commands,
    recordHandler,
    recordExec: execCalls.add,
    recordMessage: messages.add,
    recordSend: sendMessages.add,
  });
  const ui = {
    setStatus(id: string, value: string | undefined) {
      statuses.add([id, value]);
    },
    notify(message: string, level: string) {
      notices.add({ message, level });
    },
  };
  const ctx = { ui };
  registerHeartbeat(pi as never);
  const tool = () => tools.get("pstack_loop") as ToolDefinition;
  return {
    tool,
    command: () => commands.get("pstack-loop") as CommandDefinition,
    emit: (event: string) => {
      for (const handler of handlers[event] ?? []) handler();
    },
    execCalls: execCalls.all,
    messages: () => messages.all().map((entry) => entry.text),
    messageEntries: messages.all,
    notices: notices.all,
    statuses: statuses.all,
    sendMessages: sendMessages.all,
    ctx,
    execute: (params: Record<string, unknown>) =>
      tool().execute("call", params, undefined, undefined, ctx),
  };
}

test("loop-01 registers pstack_loop with the documented parameter schema", () => {
  const tool = fakeHeartbeat().tool();
  assert.equal(tool.name, "pstack_loop");
  assert.equal(tool.label, "Pstack Loop");
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), [
    "action",
    "mode",
    "prompt",
    "intervalSeconds",
    "maxFires",
    "watchArgv",
    "watchCommand",
    "id",
  ]);
  assert.equal(tool.parameters.properties.action.type, "string");
  assert.equal(tool.parameters.properties.mode.type, "string");
  assert.equal(tool.parameters.properties.prompt.type, "string");
  assert.equal(tool.parameters.properties.id.type, "string");
});

test("loop-02 defaults mode to interval intervalSeconds to 1800 and maxFires to 50", async () => {
  const env = fakeHeartbeat();
  const armed = await env.execute({ action: "arm", prompt: "wake" });
  assert.equal(
    armed.content[0].text,
    "Armed loop-1 mode=interval intervalSeconds=1800 maxFires=50 coalesceMs=2500",
  );
  assert.deepEqual(armed.details, { id: "loop-1", mode: "interval", coalesceMs: 2500 });
  const custom = await env.execute({
    action: "arm",
    prompt: "wake",
    mode: "settle",
    intervalSeconds: 30,
    maxFires: 4,
    id: "custom",
  });
  assert.equal(custom.content[0].text, "Armed custom mode=settle intervalSeconds=30 maxFires=4 coalesceMs=2500");
  const status = await env.execute({ action: "status" });
  assert.equal(
    status.content[0].text,
    [
      "loop-1 mode=interval fires=0/50 armed=true lastReason=-",
      "custom mode=settle fires=0/4 armed=true lastReason=-",
    ].join("\n"),
  );
});

test("loop-03 throws prompt required to arm when arming without a prompt", async () => {
  const env = fakeHeartbeat();
  await assert.rejects(env.execute({ action: "arm" }), { message: "prompt required to arm" });
  await assert.rejects(env.execute({ action: "arm", prompt: "" }), {
    message: "prompt required to arm",
  });
  const status = await env.execute({ action: "status" });
  assert.equal(status.content[0].text, "(no active loops)");
});

test("loop-04 throws action must be arm|stop|status|list for an unknown action", async () => {
  const env = fakeHeartbeat();
  await assert.rejects(env.execute({ action: "explode", prompt: "x" }), {
    message: "action must be arm|stop|status|list",
  });
});

test("loop-05 throws mode must be interval|settle|watcher|dynamic for an invalid mode", async () => {
  const env = fakeHeartbeat();
  for (const mode of ["cron", "Interval"]) {
    await assert.rejects(env.execute({ action: "arm", mode, prompt: "x" }), {
      message: "mode must be interval|settle|watcher|dynamic",
    });
  }
});

test("loop-06 rejects watchCommand and requires watchArgv as an argv array", async () => {
  const tool = fakeHeartbeat().tool();
  assert.equal(tool.parameters.properties.watchArgv.type, "array");
  assert.equal(tool.parameters.properties.watchArgv.items?.type, "string");
  assert.equal(tool.parameters.properties.watchCommand.type, "string");
  const env = fakeHeartbeat();
  await assert.rejects(
    env.execute({ action: "arm", mode: "watcher", prompt: "wake", watchCommand: "bash -lc echo hi" }),
    {
      message:
        "watchCommand is rejected (no bash -lc of model strings); pass watchArgv as an argv array",
    },
  );
});

test("loop-07 constrains intervalSeconds to 5 through 86400 and maxFires to 1 through 500", () => {
  const properties = fakeHeartbeat().tool().parameters.properties;
  assert.equal(properties.intervalSeconds.type, "integer");
  assert.equal(properties.intervalSeconds.minimum, 5);
  assert.equal(properties.intervalSeconds.maximum, 86400);
  assert.equal(properties.maxFires.type, "integer");
  assert.equal(properties.maxFires.minimum, 1);
  assert.equal(properties.maxFires.maximum, 500);
});

test("loop-08 arms the interval timer at arm time and re-arms it after each fire", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = fakeHeartbeat();
  await env.execute({ action: "arm", prompt: "tick", intervalSeconds: 60, maxFires: 3, id: "alarm" });
  assert.deepEqual(env.messages(), []);
  t.mock.timers.tick(59_999);
  assert.deepEqual(env.messages(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(env.messages(), ["[pstack_loop alarm fire 1/3 reason=interval]\ntick"]);
  t.mock.timers.tick(60_000);
  assert.deepEqual(env.messages(), [
    "[pstack_loop alarm fire 1/3 reason=interval]\ntick",
    "[pstack_loop alarm fire 2/3 reason=interval]\ntick",
  ]);
});

test("loop-09 arms the settle timer only on agent_settled for settle and dynamic modes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = fakeHeartbeat(pendingExec);
  await env.execute({ action: "arm", mode: "settle", prompt: "settled", intervalSeconds: 5, id: "s" });
  await env.execute({ action: "arm", mode: "dynamic", prompt: "dyn", intervalSeconds: 5, id: "d" });
  await env.execute({
    action: "arm",
    mode: "watcher",
    prompt: "watched",
    watchArgv: ["waiter"],
    id: "w",
  });
  t.mock.timers.tick(60_000);
  assert.deepEqual(env.messages(), []);
  env.emit("agent_settled");
  t.mock.timers.tick(5_000);
  assert.deepEqual(env.messages(), [
    "[pstack_loop s fire 1/50 reason=settle]\nsettled",
    "[pstack_loop d fire 1/50 reason=settle]\ndyn",
  ]);
});

test("loop-10 fires a watcher-mode loop once on exit and never re-arms it", async () => {
  const env = fakeHeartbeat(async () => ({ code: 0, stdout: "READY", stderr: "" }));
  await env.execute({
    action: "arm",
    mode: "watcher",
    prompt: "wake",
    watchArgv: ["watch-pr", "--status-only"],
    id: "w",
  });
  await flush();
  await flush();
  assert.equal(env.execCalls().length, 1);
  assert.deepEqual(env.messages(), [
    "[pstack_loop w fire 1/50 reason=watcher]\nwake\n\n--- watcher output ---\nREADY",
  ]);
});

test("loop-11 re-arms the watcher after each fire in dynamic mode while armed and under maxFires", async () => {
  let calls = 0;
  const env = fakeHeartbeat(async () => {
    calls = calls + 1;
    return calls === 1 ? { code: 0, stdout: "first", stderr: "" } : pendingExec();
  });
  await env.execute({ action: "arm", mode: "dynamic", prompt: "wake", watchArgv: ["watch-pr"], id: "d" });
  await flush();
  assert.equal(env.execCalls().length, 2);
  assert.deepEqual(env.messages(), [
    "[pstack_loop d fire 1/50 reason=watcher]\nwake\n\n--- watcher output ---\nfirst",
  ]);
  const capped = fakeHeartbeat(async () => ({ code: 0, stdout: "x", stderr: "" }));
  await capped.execute({
    action: "arm",
    mode: "dynamic",
    prompt: "wake",
    watchArgv: ["watch-pr"],
    maxFires: 1,
    id: "cap",
  });
  await flush();
  await flush();
  assert.equal(capped.execCalls().length, 1);
  const deferred = createDeferred();
  let round = 0;
  const stopped = fakeHeartbeat(async () => {
    round = round + 1;
    return round === 1 ? { code: 0, stdout: "one", stderr: "" } : deferred.promise;
  });
  await stopped.execute({ action: "arm", mode: "dynamic", prompt: "wake", watchArgv: ["watch-pr"], id: "g" });
  await flush();
  assert.equal(stopped.execCalls().length, 2);
  await stopped.execute({ action: "stop", id: "g" });
  deferred.resolve({ code: 0, stdout: "late", stderr: "" });
  await flush();
  assert.equal(stopped.execCalls().length, 2);
  assert.equal(stopped.messages().length, 1);
});

test("loop-16 delivers the fire as a follow-up message with the documented prefix", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = fakeHeartbeat();
  await env.execute({ action: "arm", prompt: "run the checks", intervalSeconds: 5, maxFires: 4, id: "beam" });
  t.mock.timers.tick(5_000);
  assert.deepEqual(env.messages(), ["[pstack_loop beam fire 1/4 reason=interval]\nrun the checks"]);
  assert.deepEqual(env.messageEntries()[0].opts, { deliverAs: "followUp" });
  t.mock.timers.tick(5_000);
  assert.deepEqual(env.messages().at(-1), "[pstack_loop beam fire 2/4 reason=interval]\nrun the checks");
});

test("loop-17 resets the prompt to the base prompt after each fire", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const deferred = createDeferred();
  let calls = 0;
  const env = fakeHeartbeat(async () => {
    calls = calls + 1;
    return calls === 1 ? { code: 0, stdout: "FIRST-OUTPUT", stderr: "" } : deferred.promise;
  });
  await env.execute({ action: "arm", mode: "dynamic", prompt: "base", watchArgv: ["watch-pr"], intervalSeconds: 5, id: "d" });
  await flush();
  assert.deepEqual(env.messages(), [
    "[pstack_loop d fire 1/50 reason=watcher]\nbase\n\n--- watcher output ---\nFIRST-OUTPUT",
  ]);
  t.mock.timers.tick(10_000);
  env.emit("agent_settled");
  t.mock.timers.tick(5_000);
  assert.equal(env.messages().length, 2);
  assert.equal(env.messages()[1], "[pstack_loop d fire 2/50 reason=settle]\nbase");
});

test("loop-18 runs watchArgv as command plus args with a 24-hour timeout and guards a dashed argv0", async () => {
  const env = fakeHeartbeat();
  await env.execute({
    action: "arm",
    mode: "watcher",
    prompt: "wake",
    watchArgv: ["watch-pr", "--pr", "5", "--status-only"],
    maxFires: 1,
    id: "w",
  });
  await flush();
  assert.equal(env.execCalls()[0].command, "watch-pr");
  assert.deepEqual(env.execCalls()[0].args, ["--pr", "5", "--status-only"]);
  assert.equal(env.execCalls()[0].timeout, 86_400_000);
  assert.equal(env.execCalls()[0].signal instanceof AbortSignal, true);
  const guard = fakeHeartbeat();
  await assert.rejects(
    guard.execute({ action: "arm", mode: "watcher", prompt: "wake", watchArgv: ["--dashed", "x"] }),
    { message: "watchArgv[0] must be a command path/name (not an option)" },
  );
  assert.deepEqual(guard.execCalls(), []);
});

test("loop-20 requires watchArgv for mode=watcher and rejects an empty or dashed argv0", async () => {
  const env = fakeHeartbeat();
  const watcher = { action: "arm", mode: "watcher", prompt: "wake" };
  await assert.rejects(env.execute(watcher), { message: "watchArgv required for mode=watcher" });
  await assert.rejects(env.execute({ ...watcher, watchArgv: [] }), {
    message: "watchArgv required for mode=watcher",
  });
  await assert.rejects(env.execute({ ...watcher, watchArgv: [""] }), {
    message: "watchArgv[0] must be a command path/name (not an option)",
  });
  await assert.rejects(env.execute({ ...watcher, watchArgv: ["-x"] }), {
    message: "watchArgv[0] must be a command path/name (not an option)",
  });
  assert.deepEqual(env.execCalls(), []);
});

test("loop-21 clears every loop and aborts running watchers on session_shutdown", async () => {
  const env = fakeHeartbeat(pendingExec);
  await env.execute({ action: "arm", mode: "watcher", prompt: "a", watchArgv: ["waiter-a"], id: "a" });
  await env.execute({ action: "arm", mode: "watcher", prompt: "b", watchArgv: ["waiter-b"], id: "b" });
  await flush();
  assert.deepEqual(env.execCalls().map((call) => call.command), ["waiter-a", "waiter-b"]);
  assert.deepEqual(env.execCalls().map((call) => call.signal?.aborted), [false, false]);
  env.emit("session_shutdown");
  assert.deepEqual(env.execCalls().map((call) => call.signal?.aborted), [true, true]);
  const status = await env.execute({ action: "status" });
  assert.equal(status.content[0].text, "(no active loops)");
});

test("loop-22 returns one formatted row per loop for status and list and stops one or all loops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = fakeHeartbeat();
  await env.execute({ action: "arm", prompt: "one", intervalSeconds: 5, id: "a" });
  await env.execute({ action: "arm", mode: "settle", prompt: "two", intervalSeconds: 5, id: "b" });
  t.mock.timers.tick(5_000);
  const rows = [
    "a mode=interval fires=1/50 armed=true lastReason=interval",
    "b mode=settle fires=0/50 armed=true lastReason=-",
  ];
  const status = await env.execute({ action: "status" });
  assert.equal(status.content[0].text, rows.join("\n"));
  assert.deepEqual(status.details, { loops: ["a", "b"], action: "status" });
  const list = await env.execute({ action: "list" });
  assert.equal(list.content[0].text, rows.join("\n"));
  assert.deepEqual(list.details, { loops: ["a", "b"], action: "list" });
  const stopped = await env.execute({ action: "stop", id: "a" });
  assert.equal(stopped.content[0].text, "stopped");
  const remaining = await env.execute({ action: "status" });
  assert.equal(remaining.content[0].text, rows[1]);
  await env.execute({ action: "stop" });
  const empty = await env.execute({ action: "list" });
  assert.equal(empty.content[0].text, "(no active loops)");
  assert.deepEqual(empty.details, { loops: [], action: "list" });
});

test("loop-23 arms an interval loop from /pstack-loop seconds prompt with maxFires 100 and a 5s floor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = fakeHeartbeat();
  const command = env.command();
  await command.handler("10 run the suite", env.ctx);
  assert.deepEqual(env.notices()[0], { message: "Armed loop-1 every 10s", level: "info" });
  t.mock.timers.tick(9_999);
  assert.deepEqual(env.messages(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(env.messages(), ["[pstack_loop loop-1 fire 1/100 reason=interval]\nrun the suite"]);
  await command.handler("1 quick", env.ctx);
  t.mock.timers.tick(4_999);
  assert.equal(env.messages().length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(env.messages().at(-1), "[pstack_loop loop-2 fire 1/100 reason=interval]\nquick");
});

test("loop-24 treats status list stop and off command forms as status and stop", async () => {
  const env = fakeHeartbeat();
  const command = env.command();
  await command.handler("30 keep going", env.ctx);
  const row = "loop-1 mode=interval fires=0/100 armed=true lastReason=-";
  await command.handler("status", env.ctx);
  assert.deepEqual(env.notices().at(-1), { message: row, level: "info" });
  await command.handler("list", env.ctx);
  assert.deepEqual(env.notices().at(-1), { message: row, level: "info" });
  await command.handler("stop loop-1", env.ctx);
  assert.deepEqual(env.notices().at(-1), { message: "Stopped loop-1", level: "info" });
  await command.handler("status", env.ctx);
  assert.deepEqual(env.notices().at(-1), { message: "(no active loops)", level: "info" });
  await command.handler("30 keep going", env.ctx);
  await command.handler("off", env.ctx);
  assert.deepEqual(env.notices().at(-1), { message: "All pstack loops stopped.", level: "info" });
  await command.handler("30 keep going", env.ctx);
  await command.handler("stop", env.ctx);
  assert.deepEqual(env.notices().at(-1), { message: "All pstack loops stopped.", level: "info" });
  await command.handler("list", env.ctx);
  assert.deepEqual(env.notices().at(-1), { message: "(no active loops)", level: "info" });
});
