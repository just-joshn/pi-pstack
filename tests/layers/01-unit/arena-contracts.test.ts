import { expect, test } from "vitest";
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
  expect(tool, "registerArena must register a tool").toBeTruthy();
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
  expect(tool.name).toBe("pstack_arena");
  expect(tool.promptSnippet).toBe("Parallel design/code candidates for arena synthesis");
  expect(tool.parameters.required).toEqual(["prompt", "candidates"]);
  expect(tool.parameters.properties.prompt.type).toBe("string");
  expect(tool.parameters.properties.candidates.minItems).toBe(1);
  expect(tool.parameters.properties.candidates.maxItems).toBe(8);
  expect(tool.parameters.properties.candidates.maxItems).toBe(MAX_TASKS);
  expect(typeof tool.execute).toBe("function");

  const source = readFileSync(join(ROOT, "extensions/orchestration/arena.ts"), "utf8");
  expect(source.includes('name: "pstack_arena"'), "the tool literal the registry scan discovers").toBe(true);
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
    expect(dirs.length).toBe(2);
    expect(new Set(dirs).size, "candidates never share a directory").toBe(2);
    for (const dir of dirs) {
      expect(dir, "no candidate may run in the parent cwd").not.toBe(resolve(parent));
      expect(dir.startsWith(join(resolve(parent), WORKTREE_DIR)), `expected a worktree, got ${dir}`).toBe(true);
    }
    for (const dir of dirs) {
      expect(outcome.content[0].text.includes(`cwd: ${dir}`), `report names ${dir}`).toBe(true);
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
    expect(outcome.details.results[0].outputPath).toBe("artifact-a.md");
    expect(report.includes("Write your artifact under: artifact-a.md"), "the prompt carries outputPath").toBe(true);
    expect(report.includes("Decide the retry policy"), "the shared prompt is still first").toBe(true);
    expect(report.includes("Also return a short rationale naming alternatives considered and rejected.")).toBe(true);
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
    expect(poolJudgeIndex, "the pool role names the judge model").not.toBe(-1);
    const readonlyMarker = `stub-child tools=${READONLY_TOOLS.join(",")}`;
    expect(poolReport.slice(poolJudgeIndex).includes(readonlyMarker), "the judge runs readonly").toBe(true);
    expect(poolReport.slice(0, poolJudgeIndex).includes(readonlyMarker), "candidates are not readonly").toBe(false);

    const explicit = await tool.execute(
      "t",
      { prompt: "Pick a base", candidates, crossJudge: true, judgeModel: "stub/explicit-judge" },
      undefined,
      undefined,
      arenaCtx(parent),
    );
    expect(explicit.content[0].text.indexOf("## Cross-judge (stub/explicit-judge)")).not.toBe(-1);
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
    expect(report.startsWith("## Arena candidates")).toBe(true);
    const judgeIndex = report.indexOf("## Cross-judge (stub/verdict-judge)");
    expect(judgeIndex, "the judge section names the judge model").not.toBe(-1);
    expect(judgeIndex > report.indexOf("### beta (stub/candidate-b"), "the judge follows the candidates").toBe(true);
    const judgeSection = report.slice(judgeIndex);
    expect(judgeSection.includes("You are an arena cross-judge"), "the judge verdict text is appended").toBe(true);
    expect(judgeSection.includes("Prefer the smaller diff"), "the rubric reached the judge").toBe(true);
    expect(report.indexOf("Next: pick a base and graft per the arena skill.") > judgeIndex).toBe(true);
  } finally {
    restoreScript();
    rmSync(parent, { recursive: true, force: true });
  }
});
