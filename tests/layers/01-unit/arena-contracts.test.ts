import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot } from "../../support/repo-root.mjs";
import { registerArena } from "../../../extensions/orchestration/arena.ts";
import { MAX_TASKS, READONLY_TOOLS } from "../../../extensions/subagents/child-runner.ts";

const WORKTREE_DIR = ".pstack-worktrees";
const ROOT = repoRoot(import.meta.url);

interface ToolTextPart {
  type: string;
  text: string;
}

interface ArenaCandidateResult {
  label: string;
  outputPath?: string;
  cwd: string;
  result: { model: string; exitCode: number; output: string };
}

interface ArenaOutcome {
  content: ToolTextPart[];
  details: { results: ArenaCandidateResult[]; concurrencyCap: number };
}

interface CapturedTool {
  name: string;
  promptSnippet: string;
  parameters: {
    required?: string[];
    properties: Record<string, { type?: string; minItems?: number; maxItems?: number }>;
  };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ArenaOutcome>;
}

function captureArena(): CapturedTool {
  let tool: CapturedTool | undefined;
  const pi = {
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
  };
  registerArena(pi as never);
  assert.ok(tool, "registerArena must register a tool");
  return tool;
}

function arenaCtx(cwd: string) {
  return { cwd, model: { provider: "pstack-test", id: "parent" }, isProjectTrusted: () => true };
}

const STUB_CHILD_SOURCE = [
  'const task = process.argv.at(-1) ?? "";',
  'const toolsIndex = process.argv.indexOf("--tools");',
  'const tools = toolsIndex >= 0 ? process.argv[toolsIndex + 1] : "none";',
  "const text = [",
  '  "stub-child cwd=" + process.cwd(),',
  '  "stub-child tools=" + tools,',
  '  "stub-child prompt=" + task,',
  '  "PASS",',
  '].join("\\n");',
  'const message = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };',
  'process.stdout.write(JSON.stringify(message) + "\\n");',
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

function withFakeGit(parent: string): { restore: () => void } {
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
    restore: () => {
      if (savedPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = savedPath;
      if (savedLog === undefined) Reflect.deleteProperty(process.env, "PSTACK_TEST_GIT_LOG");
      else process.env.PSTACK_TEST_GIT_LOG = savedLog;
    },
  };
}

function writePoolConfig(parent: string, model: string): void {
  mkdirSync(join(parent, ".pi"), { recursive: true });
  writeFileSync(
    join(parent, ".pi", "pstack-models.json"),
    `${JSON.stringify({ version: 1, roles: { "arena cross-judge pool": model } }, null, 2)}\n`,
    "utf8",
  );
}

test("arena-01 registers pstack_arena with a required prompt and one to eight candidates", () => {
  const tool = captureArena();
  assert.equal(tool.name, "pstack_arena");
  assert.equal(tool.promptSnippet, "Parallel design/code candidates for arena synthesis");
  assert.deepEqual(tool.parameters.required, ["prompt", "candidates"]);
  assert.equal(tool.parameters.properties.prompt.type, "string");
  assert.equal(tool.parameters.properties.candidates.minItems, 1);
  assert.equal(tool.parameters.properties.candidates.maxItems, 8);
  assert.equal(tool.parameters.properties.candidates.maxItems, MAX_TASKS);
  assert.equal(typeof tool.execute, "function");

  const source = readFileSync(join(ROOT, "extensions/orchestration/arena.ts"), "utf8");
  assert.equal(source.includes('name: "pstack_arena"'), true, "the tool literal the registry scan discovers");
});

test("arena-02 isolates each candidate on a path that differs from the parent cwd", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pstack-arena-iso-"));
  const git = withFakeGit(parent);
  const restoreScript = setChildScript(writeStubChild(parent));
  try {
    const tool = captureArena();
    const outcome = await tool.execute(
      "t",
      {
        prompt: "Resolve the shared design question",
        candidates: [{ model: "stub/candidate-a" }, { model: "stub/candidate-b" }],
      },
      undefined,
      undefined,
      arenaCtx(parent),
    );

    const dirs = outcome.details.results.map((entry) => resolve(entry.cwd));
    assert.equal(dirs.length, 2);
    assert.equal(new Set(dirs).size, 2, "candidates never share a directory");
    for (const dir of dirs) {
      assert.notEqual(dir, resolve(parent), "no candidate may run in the parent cwd");
      assert.equal(dir.startsWith(join(resolve(parent), WORKTREE_DIR)), true, `expected a worktree, got ${dir}`);
    }
    for (const dir of dirs) {
      assert.equal(outcome.content[0].text.includes(`cwd: ${dir}`), true, `report names ${dir}`);
    }
  } finally {
    restoreScript();
    git.restore();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("arena-03 plumbs the per-candidate output path into the child prompt", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pstack-arena-path-"));
  const candidateDir = join(parent, "candidate-a");
  mkdirSync(candidateDir, { recursive: true });
  const restoreScript = setChildScript(writeStubChild(parent));
  try {
    const tool = captureArena();
    const outcome = await tool.execute(
      "t",
      {
        prompt: "Decide the retry policy",
        candidates: [{ model: "stub/candidate-a", cwd: candidateDir, outputPath: "artifact-a.md" }],
      },
      undefined,
      undefined,
      arenaCtx(parent),
    );

    const report = outcome.content[0].text;
    assert.equal(outcome.details.results[0].outputPath, "artifact-a.md");
    assert.equal(report.includes("Write your artifact under: artifact-a.md"), true, "the prompt carries outputPath");
    assert.equal(report.includes("Decide the retry policy"), true, "the shared prompt is still first");
    assert.equal(report.includes("Also return a short rationale naming alternatives considered and rejected."), true);
  } finally {
    restoreScript();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("arena-04 resolves the cross-judge from the pool or judgeModel and forces readonly tools", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pstack-arena-judge-"));
  writePoolConfig(parent, "stub/pool-judge");
  const dirA = join(parent, "candidate-a");
  const dirB = join(parent, "candidate-b");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const restoreScript = setChildScript(writeStubChild(parent));
  try {
    const tool = captureArena();
    const candidates = [
      { model: "stub/candidate-a", cwd: dirA },
      { model: "stub/candidate-b", cwd: dirB },
    ];
    const fromPool = await tool.execute(
      "t",
      { prompt: "Pick a base", candidates, crossJudge: true },
      undefined,
      undefined,
      arenaCtx(parent),
    );
    const poolReport = fromPool.content[0].text;
    const poolJudgeIndex = poolReport.indexOf("## Cross-judge (stub/pool-judge)");
    assert.notEqual(poolJudgeIndex, -1, "the pool role names the judge model");
    const readonlyMarker = `stub-child tools=${READONLY_TOOLS.join(",")}`;
    assert.equal(poolReport.slice(poolJudgeIndex).includes(readonlyMarker), true, "the judge runs readonly");
    assert.equal(poolReport.slice(0, poolJudgeIndex).includes(readonlyMarker), false, "candidates are not readonly");

    const explicit = await tool.execute(
      "t",
      { prompt: "Pick a base", candidates, crossJudge: true, judgeModel: "stub/explicit-judge" },
      undefined,
      undefined,
      arenaCtx(parent),
    );
    assert.notEqual(explicit.content[0].text.indexOf("## Cross-judge (stub/explicit-judge)"), -1);
  } finally {
    restoreScript();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("arena-05 appends the cross-judge verdict to the report after the candidates", async () => {
  const parent = mkdtempSync(join(tmpdir(), "pstack-arena-verdict-"));
  const dirA = join(parent, "candidate-a");
  const dirB = join(parent, "candidate-b");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  const restoreScript = setChildScript(writeStubChild(parent));
  try {
    const tool = captureArena();
    const outcome = await tool.execute(
      "t",
      {
        prompt: "Pick a base",
        candidates: [
          { model: "stub/candidate-a", cwd: dirA, label: "alpha" },
          { model: "stub/candidate-b", cwd: dirB, label: "beta" },
        ],
        crossJudge: true,
        judgeModel: "stub/verdict-judge",
        rubric: "Prefer the smaller diff",
      },
      undefined,
      undefined,
      arenaCtx(parent),
    );

    const report = outcome.content[0].text;
    assert.equal(report.startsWith("## Arena candidates"), true);
    const judgeIndex = report.indexOf("## Cross-judge (stub/verdict-judge)");
    assert.notEqual(judgeIndex, -1, "the judge section names the judge model");
    assert.equal(judgeIndex > report.indexOf("### beta (stub/candidate-b"), true, "the judge follows the candidates");
    const judgeSection = report.slice(judgeIndex);
    assert.equal(judgeSection.includes("You are an arena cross-judge"), true, "the judge verdict text is appended");
    assert.equal(judgeSection.includes("Prefer the smaller diff"), true, "the rubric reached the judge");
    assert.equal(report.indexOf("Next: pick a base and graft per the arena skill.") > judgeIndex, true);
  } finally {
    restoreScript();
    rmSync(parent, { recursive: true, force: true });
  }
});
