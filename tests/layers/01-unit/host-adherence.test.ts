/**
 * Host-adherence regression test: the ExtensionAPI rules the adapter must keep.
 * Each test name is cited by a spec/contracts/host.tsv row.
 */
import { expect, test } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { repoRoot } from "../../support/repo-root.mjs";
import piPstack from "../../../extensions/index.ts";
import { computeReadonlyTools } from "../../../extensions/readonly-state/index.ts";
import { capToolOutput } from "../../../extensions/lib/tool-output.ts";
import { stripAtPrefix } from "../../../extensions/lib/paths.ts";
import { projectConfigCwd } from "../../../extensions/models/config.ts";
import {
  __resetBackgroundJobsForTests,
  __seedBackgroundJobForTests,
  abortAllBackgroundJobs,
  listBackgroundJobs,
} from "../../../extensions/subagents/child-runner.ts";
import { registerBenny } from "../../../extensions/benny/index.ts";
import { registerCompanions } from "../../../extensions/companions/index.ts";
import { loadRun } from "../../../extensions/loop/run-store.ts";

const ROOT = repoRoot(import.meta.url);

interface CapturedTool {
  name: string;
  description: string;
  promptGuidelines?: string[];
  parameters?: {
    properties?: Record<string, ToolProperty>;
  };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

interface ToolProperty {
  type?: string;
  enum?: string[];
  properties?: Record<string, ToolProperty>;
}

type EventHandler = (...args: unknown[]) => unknown;

interface RecordedApi {
  api: Record<string, unknown>;
  tools: Map<string, CapturedTool>;
  handlers: Record<string, EventHandler[]>;
  commands: Map<string, unknown>;
}

function fakeExtensionApi(): RecordedApi {
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, unknown>();
  let handlers: Record<string, EventHandler[]> = {};
  const active = ["read", "grep", "find", "ls", "write", "edit", "bash", "webfetch"];
  const api = {
    on(event: string, handler: EventHandler) {
      handlers = { ...handlers, [event]: [...(handlers[event] ?? []), handler] };
    },
    registerTool(definition: CapturedTool) {
      tools.set(definition.name, definition);
    },
    registerCommand(name: string, spec: unknown) {
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
    setActiveTools() {},
    sendUserMessage() {},
    sendMessage() {},
    exec() {
      return Promise.resolve({ stdout: "", stderr: "", code: 0, killed: false });
    },
  };
  piPstack(api as never);
  return { api, tools, handlers, commands };
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function propertyAt(tool: CapturedTool, path: string[]): ToolProperty | undefined {
  let current: ToolProperty | undefined = { properties: tool.parameters?.properties };
  for (const key of path) current = current?.properties?.[key];
  return current;
}

test("host-01 sendUserMessage call sites in extensions pass deliverAs", () => {
  const files = listSourceFiles(join(ROOT, "extensions")).filter(
    (path) => !path.includes(`${sep}test${sep}`),
  );
  let matches = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/pi\.sendUserMessage\(/g)) {
      matches = matches + 1;
      const call = text.slice(match.index ?? 0, (match.index ?? 0) + 400);
      expect(call.includes("deliverAs"), `${relative(ROOT, file)} needs deliverAs`).toBe(true);
    }
  }
  expect(matches >= 8, `expected the sendUserMessage call sites, found ${matches}`).toBeTruthy();
});

test("host-02 computeReadonlyTools preserves an unrelated tool", () => {
  const blocked = new Set(["write", "edit", "bash", "pstack_ship"]);
  const { nextActive, toolsBefore } = computeReadonlyTools(
    ["read", "webfetch", "write", "pstack_ship"],
    ["read", "webfetch", "write", "pstack_ship"],
    blocked,
  );
  expect(toolsBefore).toEqual(["read", "webfetch", "write", "pstack_ship"]);
  expect(nextActive).toEqual(["read", "grep", "find", "ls", "webfetch"]);
});

test("host-03 closed choice parameters are JSON-schema enums", () => {
  const env = fakeExtensionApi();
  const checks: Array<[string, string[]]> = [
    ["pstack_benny_wake", ["action"]],
    ["pstack_benny_wake", ["intent"]],
    ["pstack_swarm", ["selection"]],
    ["pstack_worktree", ["action"]],
    ["pstack_loop", ["action"]],
    ["pstack_loop", ["mode"]],
    ["pstack_babysit", ["recipeId"]],
    ["pstack_ship", ["action"]],
    ["pstack_ship", ["mergeMethod"]],
    ["pstack_integrations", ["action"]],
    ["pstack_run", ["action"]],
    ["pstack_run", ["mode"]],
    ["pstack_task", ["permissions", "filesystem"]],
    ["pstack_task", ["permissions", "shell"]],
    ["pstack_task", ["permissions", "git"]],
    ["pstack_task", ["permissions", "network"]],
    ["pstack_task", ["permissions", "environment"]],
    ["pstack_task", ["permissions", "isolation"]],
    ["pstack_task", ["thinkingLevel"]],
    ["pstack_task", ["sessionMode"]],
    ["pstack_sessions", ["action"]],
    ["pstack_spawn", ["sessionMode"]],
    ["pstack_jobs", ["action"]],
  ];
  for (const [name, path] of checks) {
    const tool = env.tools.get(name);
    expect(tool, `${name} is registered`).toBeTruthy();
    const property = propertyAt(tool, path);
    expect(Array.isArray(property?.enum), `${name}.${path.join(".")} must be an enum`).toBe(true);
    expect((property?.enum ?? []).length >= 2, `${name}.${path.join(".")} must list choices`).toBeTruthy();
  }
  const task = env.tools.get("pstack_task");
  const filesystem = propertyAt(task as CapturedTool, ["permissions", "filesystem"]);
  expect(filesystem?.enum).toEqual(["read-only", "workspace-write"]);
});

test("host-04 every promptGuidelines bullet names its registered tool", () => {
  const env = fakeExtensionApi();
  expect(env.tools.size >= 17, `expected the registered tool surface, found ${env.tools.size}`).toBeTruthy();
  let bullets = 0;
  for (const tool of env.tools.values()) {
    for (const bullet of tool.promptGuidelines ?? []) {
      bullets = bullets + 1;
      expect(bullet.includes(tool.name), `${tool.name} guideline does not name the tool: ${bullet}`).toBe(true);
    }
  }
  expect(bullets >= 40, `expected the guideline surface, found ${bullets}`).toBeTruthy();
});

test("host-05 capToolOutput truncates and names the full-output path", () => {
  const big = `${"line\n".repeat(5000)}tail-marker`;
  const head = capToolOutput(big, { keep: "head", label: "host-head" });
  expect(head.truncated).toBe(true);
  expect(head.text).toMatch(/\[Output truncated: \d+ of \d+ lines/);
  expect(typeof head.outputPath).toBe("string");
  expect(readFileSync(head.outputPath as string, "utf8")).toBe(big);

  const tail = capToolOutput(big, { keep: "tail", label: "host-tail" });
  expect(tail.truncated).toBe(true);
  expect(tail.text.includes("tail-marker")).toBe(true);
  expect(typeof tail.outputPath).toBe("string");

  const short = capToolOutput("small", { keep: "head", label: "host-short" });
  expect(short).toEqual({ text: "small", truncated: false });
});

test("host-06 stripAtPrefix normalizes a leading at-sign", () => {
  expect(stripAtPrefix("@src/index.ts")).toBe("src/index.ts");
  expect(stripAtPrefix("src/index.ts")).toBe("src/index.ts");
  expect(stripAtPrefix("@")).toBe("");
  expect(stripAtPrefix(undefined)).toBe(undefined);
});

test("host-07 file-mutating tools await withFileMutationQueue", () => {
  const targets = [
    "extensions/decision-log/index.ts",
    "extensions/benny/index.ts",
    "extensions/companions/deslop-core.ts",
  ];
  for (const rel of targets) {
    const text = source(rel);
    expect(text, `${rel} imports the helper`).toMatch(/import \{[^}]*withFileMutationQueue[^}]*\}/s);
    expect(text, `${rel} awaits the queue`).toMatch(/await withFileMutationQueue\(/);
  }
});

test("host-08 benny and control_ui error paths throw", async () => {
  const benny = fakeExtensionApi();
  registerBenny(benny.api as never);
  const wake = benny.tools.get("pstack_benny_wake") as CapturedTool;
  await expect(() => wake.execute("t", { action: "append", payload: "   " })).rejects.toThrow(/pstack_benny_wake append requires a non-empty payload JSON string/);

  const companions = fakeExtensionApi();
  registerCompanions(companions.api as never);
  const probe = companions.tools.get("pstack_control_ui") as CapturedTool;
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
  try {
    await expect(() => probe.execute("t", { url: "http://127.0.0.1:1/", allowHosts: ["127.0.0.1"] })).rejects.toThrow(/pstack_control_ui failed: connection refused/);
  } finally {
    globalThis.fetch = original;
  }
});

test("host-09 projectConfigCwd gates project config on trust", () => {
  expect(projectConfigCwd({ cwd: "/repo" })).toBe(undefined);
  expect(projectConfigCwd({ cwd: "/repo", isProjectTrusted: () => false })).toBe(undefined);
  expect(projectConfigCwd({ cwd: "/repo", isProjectTrusted: () => true })).toBe("/repo");

  for (const rel of [
    "extensions/models/index.ts",
    "extensions/orchestration/swarm.ts",
    "extensions/orchestration/arena.ts",
    "extensions/subagents/index.ts",
    "extensions/sessions/index.ts",
  ]) {
    expect(source(rel).includes("projectConfigCwd(ctx)"), `${rel} gated on trust`).toBe(true);
  }
  expect(source("extensions/agents/task.ts").includes("isProjectTrusted: ctx.isProjectTrusted")).toBe(true);
  expect(source("extensions/models/index.ts").includes("loadModelsConfig(ctx.cwd)")).toBe(false);
});

test("host-10 project config modules use CONFIG_DIR_NAME", () => {
  for (const rel of [
    "extensions/models/config.ts",
    "extensions/decision-log/index.ts",
    "extensions/subagents/session-dir.ts",
    "extensions/subagents/child-runner.ts",
    "extensions/sessions/index.ts",
    "extensions/worktree/helpers.ts",
  ]) {
    expect(source(rel), `${rel} imports CONFIG_DIR_NAME`).toMatch(/CONFIG_DIR_NAME/);
  }
});

test("host-11 worktree shutdown cleanup reads ctx.cwd", () => {
  const text = source("extensions/worktree/index.ts");
  const handler = text.match(/pi\.on\("session_shutdown"[\s\S]{0,240}/)?.[0] ?? "";
  expect(handler.includes("ctx.cwd"), "shutdown cleanup reads ctx.cwd").toBe(true);
  expect(text.includes("process.cwd()"), "shutdown cleanup never reads process.cwd").toBe(false);
});

test("host-12 session_shutdown clears jobs and blocks armed runs", async () => {
  __resetBackgroundJobsForTests();
  const env = fakeExtensionApi();
  const dir = mkdtempSync(join(tmpdir(), "pstack-host-runs-"));
  const saved = process.env.PSTACK_RUNS_DIR;
  process.env.PSTACK_RUNS_DIR = dir;
  try {
    __seedBackgroundJobForTests({ id: "bg-host", status: "done", sessionDir: "/tmp/host" });
    expect(listBackgroundJobs().length).toBe(1);

    const run = env.tools.get("pstack_run") as CapturedTool;
    const ctx = { ui: { setStatus() {}, notify() {} } };
    await run.execute(
      "t",
      { action: "arm", runId: "host-run", predicate: "green", intervalSeconds: 60 },
      undefined,
      undefined,
      ctx,
    );
    expect(loadRun("host-run")?.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");

    const shutdown = env.handlers.session_shutdown ?? [];
    expect(shutdown.length > 0, "piPstack registers session_shutdown handlers").toBeTruthy();
    for (const handler of shutdown) await handler();
    expect(listBackgroundJobs()).toEqual([]);
    expect(loadRun("host-run")?.phase).toBe("BLOCKED");
    expect(loadRun("host-run")?.blockedReason ?? "").toMatch(/local runtime session ended/);

    abortAllBackgroundJobs();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "PSTACK_RUNS_DIR");
    else process.env.PSTACK_RUNS_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
