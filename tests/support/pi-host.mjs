/**
 * Shared fake Pi host.
 *
 * `createHost(cwd, { entry, exec, confirm })` calls `entry(host.pi)`, which registers the
 * extension under test, then returns the recording facade. Child agents are stubbed at the
 * process.argv[1] seam, and forge/worktree calls go through tests/support/fake-forge.mjs. Nothing
 * here touches the network or a real Pi session.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeGh, installFakeGit, prependPath } from "./fake-forge.mjs";

export { installFakeGh, installFakeGit, prependPath };

export const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

export const STUB_CHILD_SOURCE = [
  "const argv = process.argv;",
  "function flagValue(name) {",
  "  const index = argv.indexOf(name);",
  '  return index >= 0 ? argv[index + 1] : "none";',
  "}",
  "const text = [",
  '  "stub-child cwd=" + process.cwd(),',
  '  "stub-child model=" + flagValue("--model"),',
  '  "stub-child tools=" + flagValue("--tools"),',
  '  "stub-child prompt=" + (argv.at(-1) ?? ""),',
  '  "PASS",',
  '].join("\\n");',
  'const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };',
  'process.stdout.write(JSON.stringify(event) + "\\n");',
  "",
].join("\n");

function defaultExec() {
  return { code: 0, stdout: "", stderr: "", killed: false };
}

async function defaultConfirm() {
  return true;
}

function makeHostCounters() {
  let registrations = [];
  let entries = [];
  let messages = [];
  let statuses = [];
  let notifications = [];
  let execCalls = [];
  let activeTools = [...BUILTIN_TOOLS];
  return {
    registrations: () => [...registrations],
    addRegistration: (name) => {
      registrations = [...registrations, name];
    },
    entries: () => [...entries],
    addEntry: (customType, data) => {
      entries = [...entries, { type: "custom", customType, data }];
    },
    messages: () => [...messages],
    addMessage: (text, options) => {
      messages = [...messages, { text, options }];
    },
    statuses: () => [...statuses],
    addStatus: (key, value) => {
      statuses = [...statuses, [key, value]];
    },
    notifications: () => [...notifications],
    addNotification: (level, message) => {
      notifications = [...notifications, [level, message]];
    },
    execCalls: () => [...execCalls],
    addExecCall: (command, args) => {
      execCalls = [...execCalls, { command, args: [...args] }];
    },
    activeTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = [...names];
    },
  };
}

function makeUiContext(counters, confirmRef) {
  return {
    setStatus: (key, value) => counters.addStatus(key, value),
    notify: (message, level) => counters.addNotification(level, message),
    confirm: (title, message) => confirmRef.current(title, message),
    select: async () => undefined,
    input: async () => undefined,
    editor: async () => undefined,
  };
}

function makePiFacade(counters, commands, tools, handlers, execRef) {
  return {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, spec) {
      counters.addRegistration(name);
      commands.set(name, spec);
    },
    registerTool(definition) {
      if (tools.has(definition.name)) {
        throw new Error(`duplicate tool registration: ${definition.name}`);
      }
      tools.set(definition.name, definition);
    },
    appendEntry(customType, data) {
      counters.addEntry(customType, data);
    },
    sendUserMessage(content, options) {
      const text = typeof content === "string" ? content : JSON.stringify(content);
      counters.addMessage(text, options ?? {});
    },
    sendMessage(message) {
      counters.addMessage(String(message?.content ?? ""), { deliverAs: "custom" });
    },
    async exec(command, args, opts) {
      counters.addExecCall(command, args);
      return execRef.current(command, args, opts);
    },
    getActiveTools: () => counters.activeTools(),
    getAllTools: () => [...new Set([...BUILTIN_TOOLS, ...tools.keys()])].map((name) => ({ name })),
    setActiveTools(names) {
      counters.setActiveTools(names);
    },
  };
}

function makeHostState(cwd, options) {
  const counters = makeHostCounters();
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const execRef = { current: options.exec ?? defaultExec };
  const confirmRef = { current: options.confirm ?? defaultConfirm };
  const sessionFileRef = { current: undefined };
  return {
    pi: makePiFacade(counters, commands, tools, handlers, execRef),
    ui: makeUiContext(counters, confirmRef),
    commands,
    tools,
    handlers,
    execRef,
    confirmRef,
    sessionFileRef,
    cwd,
    registrations: counters.registrations,
    entries: counters.entries,
    messages: counters.messages,
    statuses: counters.statuses,
    notifications: counters.notifications,
    execCalls: counters.execCalls,
    activeTools: counters.activeTools,
  };
}

function makeCtx(state) {
  return {
    cwd: state.cwd,
    hasUI: true,
    model: { provider: "acceptance", id: "parent" },
    sessionManager: {
      getBranch: () => state.entries(),
      getSessionFile: () => state.sessionFileRef.current,
    },
    ui: state.ui,
  };
}

function makeEmitters(state, ctx, emit) {
  return {
    emitSessionStart: () => emit("session_start", { type: "session_start", reason: "startup" }),
    emitBeforeAgentStart: async (prompt, systemPrompt) => {
      let current = systemPrompt;
      for (const handler of state.handlers.get("before_agent_start") ?? []) {
        const result = await handler(
          { type: "before_agent_start", prompt, images: undefined, systemPrompt: current },
          ctx(),
        );
        if (result?.systemPrompt !== undefined) current = result.systemPrompt;
      }
      return current;
    },
    emitInput: async (text, source) => {
      let current = { text, images: undefined };
      for (const handler of state.handlers.get("input") ?? []) {
        const result = await handler(
          { type: "input", text: current.text, images: current.images, source },
          ctx(),
        );
        if (result?.action === "handled") return { text: "", handled: true };
        if (result?.action === "transform") {
          current = { text: result.text, images: result.images ?? current.images };
        }
      }
      return { text: current.text, handled: false };
    },
    emitToolCall: (toolName, input) => emit("tool_call", { type: "tool_call", toolName, input }),
    emitAgentSettled: () => emit("agent_settled", { type: "agent_settled" }),
    emitSessionShutdown: (reason = "quit") => emit("session_shutdown", { type: "session_shutdown", reason }),
  };
}

function makeHostApi(state) {
  const ctx = () => makeCtx(state);
  const emit = async (event, payload) => {
    let results = [];
    for (const handler of state.handlers.get(event) ?? []) {
      results = [...results, await handler(payload, ctx())];
    }
    return results;
  };

  return {
    ctx,
    emit,
    commands: state.commands,
    tools: state.tools,
    registrations: state.registrations,
    entries: state.entries,
    messages: state.messages,
    statuses: state.statuses,
    notifications: state.notifications,
    execCalls: state.execCalls,
    activeTools: state.activeTools,
    lastEntry: (customType) => state.entries().filter((entry) => entry.customType === customType).at(-1),
    setExec: (fn) => {
      state.execRef.current = fn;
    },
    setConfirm: (fn) => {
      state.confirmRef.current = fn;
    },
    setSessionFile: (path) => {
      state.sessionFileRef.current = path;
    },
    ...makeEmitters(state, ctx, emit),
  };
}

export function createHost(cwd, options = {}) {
  const state = makeHostState(cwd, options);
  if (typeof options.entry === "function") options.entry(state.pi);
  return { pi: state.pi, ...makeHostApi(state) };
}

export function processExec(command, args, opts = {}) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      cwd: opts.cwd,
      timeout: opts.timeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "", killed: false };
  } catch (error) {
    return {
      code: typeof error.status === "number" ? error.status : 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
      killed: false,
    };
  }
}

export function writeStubChild(root, source = STUB_CHILD_SOURCE) {
  const path = join(root, "stub-child.mjs");
  writeFileSync(path, source, "utf8");
  return path;
}

export function installChildScript(stubPath) {
  const saved = process.argv[1];
  process.argv[1] = stubPath;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.argv, 1);
    else process.argv[1] = saved;
  };
}

export function makeHostTempRoot(prefix = "pstack-host-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return { root, home, cwd };
}

export function installHome(home) {
  const saved = process.env.HOME;
  process.env.HOME = home;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = saved;
  };
}

export function installEnvVar(name, value) {
  const saved = process.env[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = saved;
  };
}

export function writeModelsConfig(cwd, roles) {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pstack-models.json"), `${JSON.stringify({ version: 1, roles }, null, 2)}\n`, "utf8");
}

export function runGit(env, args) {
  execFileSync("git", args, {
    cwd: env.cwd,
    env: {
      ...process.env,
      HOME: env.tmp.home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Acceptance",
      GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
      GIT_COMMITTER_NAME: "Acceptance",
      GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
    },
    stdio: "ignore",
  });
}
