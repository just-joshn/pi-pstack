import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot } from "../../support/repo-root.mjs";
import { registerSwarm, MAX_SWARM_WORKERS } from "../../../extensions/orchestration/swarm.ts";

const WORKTREE_DIR = ".pstack-worktrees";
const ROOT = repoRoot(import.meta.url);

interface ToolTextPart {
  type: string;
  text: string;
}

interface SwarmWorkerResult {
  model: string;
  exitCode: number;
  output: string;
  cwd: string;
}

interface SwarmOutcome {
  content: ToolTextPart[];
  details: {
    selection: string;
    verdicts: string[];
    winner?: number;
    results: SwarmWorkerResult[];
  };
}

interface CapturedTool {
  name: string;
  description: string;
  promptSnippet: string;
  parameters: {
    required?: string[];
    properties: Record<string, { minItems?: number; maxItems?: number }>;
  };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: { content: ToolTextPart[]; details: Record<string, unknown> }) => void,
    ctx?: unknown,
  ) => Promise<SwarmOutcome>;
}

function captureSwarm(): CapturedTool {
  let tool: CapturedTool | undefined;
  const pi = {
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
  };
  registerSwarm(pi as never);
  assert.ok(tool, "registerSwarm must register a tool");
  return tool;
}

function swarmCtx(cwd: string) {
  return { cwd, model: { provider: "pstack-test", id: "parent" } };
}

const STUB_CHILD_SOURCE = [
  'const task = process.argv.at(-1) ?? "";',
  'const delayMatch = task.match(/delay=(\\d+)/);',
  "const delayMs = delayMatch ? Number(delayMatch[1]) : 0;",
  'const toolsIndex = process.argv.indexOf("--tools");',
  'const tools = toolsIndex >= 0 ? process.argv[toolsIndex + 1] : "none";',
  "const text = [",
  '  "stub-child cwd=" + process.cwd(),',
  '  "stub-child tools=" + tools,',
  '  "stub-child prompt=" + task,',
  '  "PASS",',
  '].join("\\n");',
  "const emit = () => {",
  "  const message = { type: \"message_end\", message: { role: \"assistant\", content: [{ type: \"text\", text }] } };",
  '  process.stdout.write(JSON.stringify(message) + "\\n");',
  "};",
  "setTimeout(emit, delayMs);",
  "",
].join("\n");

function writeStubChild(dir: string): string {
  const path = join(dir, "stub-child.mjs");
  writeFileSync(path, STUB_CHILD_SOURCE, "utf8");
  return path;
}

function setChildScript(script: string): () => void {
  const saved = process.argv[1];
  process.argv[1] = script;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.argv, 1);
    else process.argv[1] = saved;
  };
}

function withFakeGit(parent: string): { logPath: string; restore: () => void } {
  const binDir = join(parent, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const logPath = join(parent, "fake-git.log");
  writeFileSync(logPath, "", "utf8");
  writeFileSync(
    join(binDir, "git"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PSTACK_TEST_GIT_LOG"\nmkdir -p "$5"\n',
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  const savedLog = process.env.PSTACK_TEST_GIT_LOG;
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
  process.env.PSTACK_TEST_GIT_LOG = logPath;
  return {
    logPath,
    restore: () => {
      if (savedPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = savedPath;
      if (savedLog === undefined) Reflect.deleteProperty(process.env, "PSTACK_TEST_GIT_LOG");
      else process.env.PSTACK_TEST_GIT_LOG = savedLog;
    },
  };
}

test("swarm-01 registers pstack_swarm with a worker array and an aggregate report", () => {
  const tool = captureSwarm();
  assert.equal(tool.name, "pstack_swarm");
  assert.equal(tool.promptSnippet, "Parallel pstack workers with aggregated report");
  assert.deepEqual(tool.parameters.required, ["workers"]);
  assert.equal(tool.parameters.properties.workers.minItems, 1);
  assert.equal(tool.parameters.properties.workers.maxItems, MAX_SWARM_WORKERS);
  assert.ok(MAX_SWARM_WORKERS > 8, "N is the total worker count; the schema must accept more than the concurrency cap");
  assert.equal(typeof tool.execute, "function");

  const source = readFileSync(join(ROOT, "extensions/orchestration/swarm.ts"), "utf8");
  assert.equal(source.includes('name: "pstack_swarm"'), true, "the tool literal the registry scan discovers");
  assert.equal(source.includes("## Swarm report"), true, "one aggregated report is assembled");
});

test("swarm-02 isolates each worker in a unique worktree even when N equals 1", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pstack-swarm-iso-"));
  const git = withFakeGit(parent);
  const restoreScript = setChildScript(writeStubChild(parent));
  try {
    const tool = captureSwarm();
    const solo = await tool.execute(
      "t",
      { workers: [{ task: "solo worker brief", model: "stub/model-solo" }] },
      undefined,
      undefined,
      swarmCtx(parent),
    );
    assert.equal(solo.details.results.length, 1);
    const soloCwd = resolve(solo.details.results[0].cwd);
    assert.notEqual(soloCwd, resolve(parent), "N=1 must not run in the parent cwd");
    assert.equal(
      soloCwd.startsWith(join(resolve(parent), WORKTREE_DIR)),
      true,
      `expected a worktree under ${WORKTREE_DIR}, got ${soloCwd}`,
    );
    assert.match(solo.content[0].text, /## Swarm report \(coverage\)/);
    assert.match(readFileSync(git.logPath, "utf8"), /worktree add -b pstack\//);

    const trio = await tool.execute(
      "t",
      {
        workers: [0, 1, 2].map((i) => ({ task: `fanout worker ${i}`, model: `stub/model-${i}` })),
      },
      undefined,
      undefined,
      swarmCtx(parent),
    );
    const dirs = trio.details.results.map((entry) => resolve(entry.cwd));
    assert.equal(dirs.length, 3);
    assert.equal(new Set(dirs).size, 3, "each worker gets its own directory");
    for (const dir of dirs) {
      assert.notEqual(dir, resolve(parent));
      assert.equal(dir.startsWith(join(resolve(parent), WORKTREE_DIR)), true);
    }
  } finally {
    restoreScript();
    git.restore();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("swarm-05 waits for all workers and aggregates their outputs into one deterministic report", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pstack-swarm-barrier-"));
  const restoreScript = setChildScript(writeStubChild(parent));
  try {
    const tool = captureSwarm();
    const workers = [
      { task: "worker brief 0 delay=250", cwd: join(parent, "w0"), model: "stub/model-0" },
      { task: "worker brief 1 delay=0", cwd: join(parent, "w1"), model: "stub/model-1" },
      { task: "worker brief 2 delay=0", cwd: join(parent, "w2"), model: "stub/model-2" },
    ];
    for (const worker of workers) mkdirSync(worker.cwd, { recursive: true });

    let updates: string[] = [];
    const result = await tool.execute(
      "t",
      { workers, selection: "coverage" },
      undefined,
      (update) => {
        updates = [...updates, ...update.content.map((part) => part.text)];
      },
      swarmCtx(parent),
    );

    const report = result.content[0].text;
    assert.equal(result.content.length, 1, "one aggregated report");
    assert.equal(result.details.results.length, 3, "every worker result is present");
    assert.deepEqual(result.details.verdicts, ["PASS", "PASS", "PASS"]);
    assert.deepEqual(updates, ["1/3 swarm workers done", "2/3 swarm workers done", "3/3 swarm workers done"]);
    assert.match(report, /## Swarm report \(coverage\)/);
    for (const worker of workers) {
      assert.equal(report.includes(worker.task), true, `report carries ${worker.task}`);
    }
    assert.equal(report.indexOf("worker brief 0") < report.indexOf("worker brief 1"), true);
    assert.equal(report.indexOf("worker brief 1") < report.indexOf("worker brief 2"), true);
  } finally {
    restoreScript();
    rmSync(parent, { recursive: true, force: true });
  }
});
