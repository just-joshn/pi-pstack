/**
 * pstack_arena — N candidates, optional cross-judge, return artifacts for graft.
 * Full graft stays in the arena skill; this tool owns fan-out + gather.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { capToolOutput } from "../lib/tool-output.ts";
import { stripAtPrefix } from "../lib/paths.ts";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_TASKS,
  MAX_TIMEOUT_MS,
  READONLY_TOOLS,
  mapConcurrent,
  runChildTask,
} from "../subagents/child-runner.ts";
import { projectConfigCwd, resolveRoleModel } from "../models/config.ts";
import { ensureAlwaysIsolated } from "../worktree/helpers.ts";

type ArenaCandidate = {
  model?: string;
  cwd?: string;
  outputPath?: string;
  label?: string;
};

type ArenaParams = {
  prompt: string;
  candidates: ArenaCandidate[];
  rubric?: string;
  crossJudge?: boolean;
  judgeModel?: string;
  timeoutMs?: number;
};

type CandidateResult = {
  label: string;
  outputPath?: string;
  cwd: string;
  result: { model: string; exitCode: number; output: string; stopReason?: string };
};

async function runArenaCandidates(
  params: ArenaParams,
  cwds: string[],
  parentModel: string,
  ctxCwd: string,
  trustedConfigCwd: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((update: { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }) => void) | undefined,
): Promise<CandidateResult[]> {
  let doneCount = 0;
  return await mapConcurrent(params.candidates, MAX_CONCURRENCY, async (c, index) => {
    const model =
      c.model ??
      resolveRoleModel("arena runners", parentModel, index, trustedConfigCwd) ??
      parentModel;
    const label = c.label ?? `candidate-${index + 1}`;
    const outputPath = stripAtPrefix(c.outputPath);
    const task = [
      params.prompt,
      outputPath ? `Write your artifact under: ${outputPath}` : "",
      "Also return a short rationale naming alternatives considered and rejected.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const result = await runChildTask(
      {
        task,
        model,
        cwd: cwds[index],
        role: "general",
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      ctxCwd,
      parentModel,
      signal,
    );
    doneCount = doneCount + 1;
    onUpdate?.({
      content: [{ type: "text", text: `${doneCount}/${params.candidates.length} arena candidates done` }],
      details: {},
    });
    return { label, outputPath, cwd: cwds[index], result };
  });
}

async function runCrossJudge(
  params: ArenaParams,
  results: CandidateResult[],
  parentModel: string,
  ctxCwd: string,
  trustedConfigCwd: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (!params.crossJudge) return "";
  const judgeModel =
    params.judgeModel ??
    resolveRoleModel("arena cross-judge pool", parentModel, 0, trustedConfigCwd) ??
    parentModel;
  const summaries = results
    .map(
      (r) =>
        `### ${r.label} (${r.result.model})\npath: ${r.outputPath ?? "(inline)"}\ncwd: ${r.cwd}\n\n${r.result.output}`,
    )
    .join("\n\n");
  const judge = await runChildTask(
    {
      task: [
        "You are an arena cross-judge. Score each candidate against the rubric. Recommend a base with rationale.",
        `Rubric:\n${params.rubric ?? "(derive from the shared prompt)"}`,
        summaries,
      ].join("\n\n"),
      model: judgeModel,
      role: "general",
      tools: [...READONLY_TOOLS],
      timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
    ctxCwd,
    parentModel,
    signal,
  );
  return `\n\n## Cross-judge (${judge.model})\n\n${judge.output}`;
}

function formatArenaResponse(results: CandidateResult[], judgeText: string) {
  const body = results
    .map(
      (r) =>
        `### ${r.label} (${r.result.model}, exit ${r.result.exitCode})\npath: ${r.outputPath ?? "(inline)"}\ncwd: ${r.cwd}\n\n${r.result.output}`,
    )
    .join("\n\n---\n\n");
  const report = `## Arena candidates\n\n${body}${judgeText}\n\nNext: pick a base and graft per the arena skill.`;
  const capped = capToolOutput(report, { keep: "head", label: "arena-report" });
  return {
    content: [
      {
        type: "text",
        text: capped.text,
      },
    ],
    details: {
      results,
      concurrencyCap: MAX_CONCURRENCY,
      ...(capped.outputPath ? { fullOutputPath: capped.outputPath } : {}),
    },
  };
}

const ARENA_DESCRIPTION =
  `Run N parallel candidates at the same task (optional cross-judge). Always isolates each candidate in a unique worktree (even N=1). Global child concurrency cap: ${MAX_CONCURRENCY}. Parent skill picks base and grafts. The aggregate report caps at 50KB / 2000 lines; a truncated report's trailer names the temp file with the full text.`;

const ARENA_PROMPT_GUIDELINES = [
  "Use pstack_arena for arena Phase B fan-out; then pick/graft per the arena skill.",
  "pstack_arena always auto-isolates candidates (even N=1). Omit cwd for auto worktree; never share parent dirty cwd.",
  `pstack_arena caps ${MAX_CONCURRENCY} concurrent children globally. pstack_arena cross-judge is read-only (no bash).`,
];

const ARENA_PARAMETERS = Type.Object({
  prompt: Type.String({ description: "Shared candidate prompt/contract" }),
  candidates: Type.Array(
    Type.Object({
      model: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      outputPath: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
    }),
    { minItems: 1, maxItems: MAX_TASKS },
  ),
  rubric: Type.Optional(Type.String({ description: "Rubric for optional cross-judge" })),
  crossJudge: Type.Optional(Type.Boolean({ description: "Spawn a readonly judge after candidates" })),
  judgeModel: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS })),
});

export function registerArena(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_arena",
    label: "Pstack Arena",
    description: ARENA_DESCRIPTION,
    promptSnippet: "Parallel design/code candidates for arena synthesis",
    promptGuidelines: ARENA_PROMPT_GUIDELINES,
    parameters: ARENA_PARAMETERS,
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!ctx.model) throw new Error("pstack_arena requires an active parent model");
      const parentModel = `${ctx.model.provider}/${ctx.model.id}`;
      const cwds = await ensureAlwaysIsolated(
        ctx.cwd,
        params.candidates.map((c, i) => ({
          cwd: stripAtPrefix(c.cwd),
          label: c.label ?? `candidate-${i + 1}`,
        })),
      );

      const results = await runArenaCandidates(
        params,
        cwds,
        parentModel,
        ctx.cwd,
        projectConfigCwd(ctx),
        signal,
        onUpdate,
      );
      const judgeText = await runCrossJudge(
        params,
        results,
        parentModel,
        ctx.cwd,
        projectConfigCwd(ctx),
        signal,
      );
      return formatArenaResponse(results, judgeText);
    },
  });
}
