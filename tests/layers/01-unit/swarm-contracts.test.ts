import { expect, test } from "vitest";
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
  expect(tool, "registerSwarm must register a tool").toBeTruthy();
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
  expect(tool.name).toBe("pstack_swarm");
  expect(tool.promptSnippet).toBe("Parallel pstack workers with aggregated report");
  expect(tool.parameters.required).toEqual(["workers"]);
  expect(tool.parameters.properties.workers.minItems).toBe(1);
  expect(tool.parameters.properties.workers.maxItems).toBe(MAX_SWARM_WORKERS);
  expect(MAX_SWARM_WORKERS > 8, "N is the total worker count; the schema must accept more than the concurrency cap").toBeTruthy();
  expect(typeof tool.execute).toBe("function");

  const source = readFileSync(join(ROOT, "extensions/orchestration/swarm.ts"), "utf8");
  expect(source.includes('name: "pstack_swarm"'), "the tool literal the registry scan discovers").toBe(true);
  expect(source.includes("## Swarm report"), "one aggregated report is assembled").toBe(true);
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
    expect(solo.details.results.length).toBe(1);
    const soloCwd = resolve(solo.details.results[0].cwd);
    expect(soloCwd, "N=1 must not run in the parent cwd").not.toBe(resolve(parent));
    expect(soloCwd.startsWith(join(resolve(parent), WORKTREE_DIR)), `expected a worktree under ${WORKTREE_DIR}, got ${soloCwd}`).toBe(true);
    expect(solo.content[0].text).toMatch(/## Swarm report \(coverage\)/);
    expect(readFileSync(git.logPath, "utf8")).toMatch(/worktree add -b pstack\//);

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
    expect(dirs.length).toBe(3);
    expect(new Set(dirs).size, "each worker gets its own directory").toBe(3);
    for (const dir of dirs) {
      expect(dir).not.toBe(resolve(parent));
      expect(dir.startsWith(join(resolve(parent), WORKTREE_DIR))).toBe(true);
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
    expect(result.content.length, "one aggregated report").toBe(1);
    expect(result.details.results.length, "every worker result is present").toBe(3);
    expect(result.details.verdicts).toEqual(["PASS", "PASS", "PASS"]);
    expect(updates).toEqual(["1/3 swarm workers done", "2/3 swarm workers done", "3/3 swarm workers done"]);
    expect(report).toMatch(/## Swarm report \(coverage\)/);
    for (const worker of workers) {
      expect(report.includes(worker.task), `report carries ${worker.task}`).toBe(true);
    }
    expect(report.indexOf("worker brief 0") < report.indexOf("worker brief 1")).toBe(true);
    expect(report.indexOf("worker brief 1") < report.indexOf("worker brief 2")).toBe(true);
  } finally {
    restoreScript();
    rmSync(parent, { recursive: true, force: true });
  }
});
