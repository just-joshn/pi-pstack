import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { afterAll } from "vitest";

import type { RoleConfig } from "../lib/models.ts";
import type { PoolResult } from "../lib/pool.ts";
import type { State } from "../lib/state.ts";
import { double, shaped, spawned } from "./support.ts";

// Vitest loads this module once per test file, so each file gets a sandbox and removes its own.
export const sandbox = await mkdtemp(join(tmpdir(), "pi-pstack-test-"));
process.env["PI_CODING_AGENT_DIR"] = sandbox;
const { default: extension } = await import("../src/index.ts");
export const configFile = join(sandbox, "pstack-models.json");

type Context = ExtensionCommandContext & ExtensionToolContext;
type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Handler = (...args: never[]) => unknown;
type Entry = Extract<
  ReturnType<Context["sessionManager"]["getBranch"]>[number],
  { type: "custom" }
>;
interface Tool {
  name: string;
  execute(
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionToolContext,
  ): Promise<{ content: { type: string; text?: string }[] }>;
}
export type ToolResponse = Awaited<ReturnType<Tool["execute"]>>;
export type Run = Pick<ExecResult, "code" | "stdout" | "stderr"> & Partial<ExecResult>;
export interface HostOptions {
  confirm?: boolean | ((title: string, message: string) => boolean | Promise<boolean>);
  mode?: Context["mode"];
  cwd?: string;
  realGit?: boolean;
  execute?: (bin: string, args: string[], options?: ExecOptions) => Run | Promise<Run>;
  extensionProviders?: string[];
  loadedExtensions?: string[];
}

export const model = (provider: string, id: string) =>
  double<Context["scopedModels"][number]["model"]>({ provider, id });
const source = (path: string) =>
  ({ path, source: "local", scope: "user", origin: "top-level" }) as const;

async function git(args: string[], cwd: string | undefined): Promise<ExecResult> {
  const { status, stdout, stderr } = await spawned("git", args, { cwd });
  return { code: status, stdout, stderr, killed: false, truncated: false };
}

export function host({
  confirm = false,
  mode = "tui",
  cwd = sandbox,
  realGit = false,
  execute,
  extensionProviders = [],
  loadedExtensions = [],
}: HostOptions = {}) {
  const sessionId = randomUUID();
  const commands = new Map<string, Command>();
  const tools = new Map<string, Tool>();
  const events = new Map<string, Handler>();
  const entries: Entry[] = [];
  const messages: string[] = [];
  const notifications: string[] = [];
  const executions: [bin: string, args: string[], options: ExecOptions | undefined][] = [];
  const sent = (content: unknown) =>
    messages.push(typeof content === "string" ? content : JSON.stringify(content));
  const pi = double<ExtensionAPI>({
    registerCommand: (name, options) => {
      assert(!commands.has(name));
      commands.set(name, options);
    },
    registerTool: (tool) => {
      assert(!tools.has(tool.name));
      tools.set(tool.name, tool);
    },
    on: (name: string, handler: Handler) => {
      events.set(name, handler);
      return () => events.delete(name);
    },
    getCommands: () => [
      { name: "skill:how", source: "skill", sourceInfo: source(join(sandbox, "SKILL.md")) },
      ...loadedExtensions.map((path) => ({
        name: "command",
        source: "extension" as const,
        sourceInfo: source(path),
      })),
    ],
    appendEntry: (customType, data) => {
      entries.push({
        type: "custom",
        id: randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      });
    },
    sendMessage: (message) => {
      sent(message.content);
    },
    sendUserMessage: (content) => {
      sent(content);
    },
    exec: async (bin, args, options) => {
      executions.push([bin, args, options]);
      if (realGit && bin === "git") return git(args, options?.cwd);
      if (!execute) throw Error("unexpected external execution");
      return { killed: false, truncated: false, ...(await execute(bin, args, options)) };
    },
  });
  const ctx = double<Context>({
    cwd,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model: model("anthropic", "claude"),
    scopedModels: [],
    modelRegistry: double<Context["modelRegistry"]>({
      getAvailable: () => [
        model("anthropic", "claude"),
        model("google", "gemini"),
        model("openai", "gpt"),
      ],
      getRegisteredProviderIds: () => extensionProviders,
    }),
    sessionManager: double<Context["sessionManager"]>({
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getBranch: () => entries,
    }),
    ui: double<Context["ui"]>({
      notify: (message) => {
        notifications.push(message);
      },
      setStatus() {},
      setWidget() {},
      confirm: async (title, message) =>
        typeof confirm === "function" ? confirm(title, message) : confirm,
      input: async () => undefined,
      select: async () => undefined,
    }),
    isIdle: () => true,
    hasPendingMessages: () => false,
  });
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
    /** The state the extension saved last. */
    state: () => shaped<State>(entries.at(-1)?.data),
    /** What `/setup-pstack show` reported last. */
    shown: () => shaped<Setup>(JSON.parse(notifications.at(-1) ?? "null")),
    emit(name: string, event: object = {}): unknown {
      const handler = events.get(name);
      assert(handler, `No handler for ${name}`);
      return Reflect.apply(handler, undefined, [event, ctx]);
    },
    async call(name: string, args: unknown, signal?: AbortSignal) {
      const tool = tools.get(name);
      assert(tool, `No tool ${name}`);
      return tool.execute("test", args, signal, undefined, ctx);
    },
    async cmd(name: string, args = "") {
      const command = commands.get(name);
      assert(command, `No command ${name}`);
      await command.handler(args, ctx);
    },
  };
}
export type Host = ReturnType<typeof host>;

export interface Setup {
  config: RoleConfig;
  available: string[];
  path: string;
  warning?: string;
}
export type Summary = Pick<State, "mode" | "goal" | "plan" | "wake"> & { complete: boolean };
export interface Report {
  id: string;
  model: string;
  path: string;
  base: string | null;
  report: string;
  transcript: string | null;
  sessionDir: string;
  summary: string;
}
export interface Delegated {
  outputs: PoolResult<Report>[];
  judgment?: {
    status: string;
    model?: string;
    error?: string;
    readAudit?: { path: string; read: boolean }[];
  };
  dir: string;
}
export interface Shipped {
  merged: { number: number; head: string; url: string }[];
  unmerged: number[];
  stopped?: number;
  unconfirmed?: number;
  reason?: string;
  error?: string;
  lookupFailure?: { number: number; error: string };
}

export function resultText(response: ToolResponse) {
  const [block] = response.content;
  assert(block?.text !== undefined, "The tool returned no text");
  return block.text;
}
export const readResult = (response: ToolResponse): unknown => JSON.parse(resultText(response));
export const delegated = (response: ToolResponse) => shaped<Delegated>(readResult(response));
export const planned = (response: ToolResponse) =>
  shaped<{ state: Summary }>(readResult(response)).state;
export const shipped = (response: ToolResponse) => shaped<Shipped>(readResult(response));
/** The value of a fulfilled pool result; fails the test for a rejected or missing one. */
export function fulfilled<T>(results: readonly PoolResult<T>[], index = 0): T {
  const result = results[index];
  assert(result?.status === "fulfilled", JSON.stringify(result));
  return result.value;
}

afterAll(() => rm(sandbox, { recursive: true, force: true }));
