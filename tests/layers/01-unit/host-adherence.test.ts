/**
 * Host-adherence regression test: the ExtensionAPI rules the adapter must keep.
 * Each test name is cited by a spec/contracts/host.tsv row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
      assert.equal(call.includes("deliverAs"), true, `${relative(ROOT, file)} needs deliverAs`);
    }
  }
  assert.ok(matches >= 8, `expected the sendUserMessage call sites, found ${matches}`);
});

test("host-02 computeReadonlyTools preserves an unrelated tool", () => {
  const blocked = new Set(["write", "edit", "bash", "pstack_ship"]);
  const { nextActive, toolsBefore } = computeReadonlyTools(
    ["read", "webfetch", "write", "pstack_ship"],
    ["read", "webfetch", "write", "pstack_ship"],
    blocked,
  );
  assert.deepEqual(toolsBefore, ["read", "webfetch", "write", "pstack_ship"]);
  assert.deepEqual(nextActive, ["read", "grep", "find", "ls", "webfetch"]);
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
    assert.ok(tool, `${name} is registered`);
    const property = propertyAt(tool, path);
    assert.equal(Array.isArray(property?.enum), true, `${name}.${path.join(".")} must be an enum`);
    assert.ok((property?.enum ?? []).length >= 2, `${name}.${path.join(".")} must list choices`);
  }
  const task = env.tools.get("pstack_task");
  const filesystem = propertyAt(task as CapturedTool, ["permissions", "filesystem"]);
  assert.deepEqual(filesystem?.enum, ["read-only", "workspace-write"]);
});

test("host-04 every promptGuidelines bullet names its registered tool", () => {
  const env = fakeExtensionApi();
  assert.ok(env.tools.size >= 17, `expected the registered tool surface, found ${env.tools.size}`);
  let bullets = 0;
  for (const tool of env.tools.values()) {
    for (const bullet of tool.promptGuidelines ?? []) {
      bullets = bullets + 1;
      assert.equal(
        bullet.includes(tool.name),
        true,
        `${tool.name} guideline does not name the tool: ${bullet}`,
      );
    }
  }
  assert.ok(bullets >= 40, `expected the guideline surface, found ${bullets}`);
});

test("host-05 capToolOutput truncates and names the full-output path", () => {
  const big = `${"line\n".repeat(5000)}tail-marker`;
  const head = capToolOutput(big, { keep: "head", label: "host-head" });
  assert.equal(head.truncated, true);
  assert.match(head.text, /\[Output truncated: \d+ of \d+ lines/);
  assert.equal(typeof head.outputPath, "string");
  assert.equal(readFileSync(head.outputPath as string, "utf8"), big);

  const tail = capToolOutput(big, { keep: "tail", label: "host-tail" });
  assert.equal(tail.truncated, true);
  assert.equal(tail.text.includes("tail-marker"), true);
  assert.equal(typeof tail.outputPath, "string");

  const short = capToolOutput("small", { keep: "head", label: "host-short" });
  assert.deepEqual(short, { text: "small", truncated: false });
});

test("host-06 stripAtPrefix normalizes a leading at-sign", () => {
  assert.equal(stripAtPrefix("@src/index.ts"), "src/index.ts");
  assert.equal(stripAtPrefix("src/index.ts"), "src/index.ts");
  assert.equal(stripAtPrefix("@"), "");
  assert.equal(stripAtPrefix(undefined), undefined);
});

test("host-07 file-mutating tools await withFileMutationQueue", () => {
  const targets = [
    "extensions/decision-log/index.ts",
    "extensions/benny/index.ts",
    "extensions/companions/deslop-core.ts",
  ];
  for (const rel of targets) {
    const text = source(rel);
    assert.match(text, /import \{[^}]*withFileMutationQueue[^}]*\}/s, `${rel} imports the helper`);
    assert.match(text, /await withFileMutationQueue\(/, `${rel} awaits the queue`);
  }
});

test("host-08 benny and control_ui error paths throw", async () => {
  const benny = fakeExtensionApi();
  registerBenny(benny.api as never);
  const wake = benny.tools.get("pstack_benny_wake") as CapturedTool;
  await assert.rejects(
    () => wake.execute("t", { action: "append", payload: "   " }),
    /pstack_benny_wake append requires a non-empty payload JSON string/,
  );

  const companions = fakeExtensionApi();
  registerCompanions(companions.api as never);
  const probe = companions.tools.get("pstack_control_ui") as CapturedTool;
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;
  try {
    await assert.rejects(
      () => probe.execute("t", { url: "http://127.0.0.1:1/", allowHosts: ["127.0.0.1"] }),
      /pstack_control_ui failed: connection refused/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("host-09 projectConfigCwd gates project config on trust", () => {
  assert.equal(projectConfigCwd({ cwd: "/repo" }), undefined);
  assert.equal(projectConfigCwd({ cwd: "/repo", isProjectTrusted: () => false }), undefined);
  assert.equal(projectConfigCwd({ cwd: "/repo", isProjectTrusted: () => true }), "/repo");

  for (const rel of [
    "extensions/models/index.ts",
    "extensions/orchestration/swarm.ts",
    "extensions/orchestration/arena.ts",
    "extensions/subagents/index.ts",
    "extensions/sessions/index.ts",
  ]) {
    assert.equal(source(rel).includes("projectConfigCwd(ctx)"), true, `${rel} gated on trust`);
  }
  assert.equal(source("extensions/agents/task.ts").includes("isProjectTrusted: ctx.isProjectTrusted"), true);
  assert.equal(source("extensions/models/index.ts").includes("loadModelsConfig(ctx.cwd)"), false);
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
    assert.match(source(rel), /CONFIG_DIR_NAME/, `${rel} imports CONFIG_DIR_NAME`);
  }
});

test("host-11 worktree shutdown cleanup reads ctx.cwd", () => {
  const text = source("extensions/worktree/index.ts");
  const handler = text.match(/pi\.on\("session_shutdown"[\s\S]{0,240}/)?.[0] ?? "";
  assert.equal(handler.includes("ctx.cwd"), true, "shutdown cleanup reads ctx.cwd");
  assert.equal(text.includes("process.cwd()"), false, "shutdown cleanup never reads process.cwd");
});

test("host-12 session_shutdown clears jobs and blocks armed runs", async () => {
  __resetBackgroundJobsForTests();
  const env = fakeExtensionApi();
  const dir = mkdtempSync(join(tmpdir(), "pstack-host-runs-"));
  const saved = process.env.PSTACK_RUNS_DIR;
  process.env.PSTACK_RUNS_DIR = dir;
  try {
    __seedBackgroundJobForTests({ id: "bg-host", status: "done", sessionDir: "/tmp/host" });
    assert.equal(listBackgroundJobs().length, 1);

    const run = env.tools.get("pstack_run") as CapturedTool;
    const ctx = { ui: { setStatus() {}, notify() {} } };
    await run.execute(
      "t",
      { action: "arm", runId: "host-run", predicate: "green", intervalSeconds: 60 },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(loadRun("host-run")?.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");

    const shutdown = env.handlers.session_shutdown ?? [];
    assert.ok(shutdown.length > 0, "piPstack registers session_shutdown handlers");
    for (const handler of shutdown) await handler();
    assert.deepEqual(listBackgroundJobs(), []);
    assert.equal(loadRun("host-run")?.phase, "BLOCKED");
    assert.match(loadRun("host-run")?.blockedReason ?? "", /local runtime session ended/);

    abortAllBackgroundJobs();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "PSTACK_RUNS_DIR");
    else process.env.PSTACK_RUNS_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
