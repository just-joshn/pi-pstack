import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

export const exec = promisify(execFile);
export const sandbox = await mkdtemp(join(tmpdir(), "pi-pstack-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;
const { default: extension } = await import("../extensions/index.ts");
export const configFile = join(sandbox, "pstack-models.json");
export function host({
  confirm = false,
  mode = "tui",
  cwd = sandbox,
  realGit = false,
  execute,
  extensionProviders = [],
} = {}) {
  const sessionId = randomUUID();
  const commands = new Map(),
    tools = new Map(),
    events = new Map(),
    entries = [],
    messages = [],
    notifications = [],
    executions = [];
  const pi = {
    registerCommand: (name, options) => {
      assert(!commands.has(name));
      commands.set(name, options);
    },
    registerTool: (t) => {
      assert(!tools.has(t.name));
      tools.set(t.name, t);
    },
    on: (name, handler) => events.set(name, handler),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendMessage: (m) => messages.push(m),
    sendUserMessage: (m) => messages.push(m),
    exec: async (...args) => {
      executions.push(args);
      if (realGit && args[0] === "git") {
        try {
          const r = await exec(args[0], args[1], { cwd: args[2]?.cwd });
          return { ...r, code: 0 };
        } catch (e) {
          return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
        }
      }
      if (execute) return execute(...args);
      throw Error("unexpected external execution");
    },
  };
  const ctx = {
    cwd,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model: { provider: "anthropic", id: "claude" },
    scopedModels: [],
    modelRegistry: {
      getAvailable: () => [
        { provider: "anthropic", id: "claude" },
        { provider: "google", id: "gemini" },
        { provider: "openai", id: "gpt" },
      ],
      getRegisteredProviderIds: () => extensionProviders,
    },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => null,
      getBranch: () => entries,
    },
    ui: {
      notify: (m) => notifications.push(m),
      setStatus() {},
      setWidget() {},
      confirm: async (...args) => (typeof confirm === "function" ? confirm(...args) : confirm),
      input: async () => undefined,
      select: async () => undefined,
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  extension(pi);
  return {
    commands,
    tools,
    events,
    entries,
    messages,
    notifications,
    executions,
    ctx,
    call: (name, args, signal) => tools.get(name).execute("test", args, signal, undefined, ctx),
    cmd: (name, args = "") => commands.get(name).handler(args, ctx),
  };
}

export const readResult = (response) => JSON.parse(response.content[0].text);

test.after(() => rm(sandbox, { recursive: true, force: true }));
