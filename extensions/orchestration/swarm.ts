/**
 * pstack_swarm — fan-out N parallel child agents, aggregate one report.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { capToolOutput } from "../lib/tool-output.ts";
import { stripAtPrefix } from "../lib/paths.ts";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_TASKS,
  MAX_TIMEOUT_MS,
  mapConcurrent,
  runChildTask,
} from "../subagents/child-runner.ts";
import { projectConfigCwd, resolveRoleModel } from "../models/config.ts";
import { ensureAlwaysIsolated } from "../worktree/helpers.ts";

type WorkerSpec = {
  task: string;
  model?: string;
  cwd?: string;
  role?: string;
};

type WorkerResult = {
  model: string;
  exitCode: number;
  stopReason?: string;
  output: string;
  cwd: string;
};

export type SwarmSelection = "coverage" | "first-pass" | "rank-all" | "best-of";

export type SwarmVerdict = "PASS" | "ISSUES" | "BLOCKED" | "UNKNOWN";

const VERDICT_RANK: Record<SwarmVerdict, number> = { PASS: 3, ISSUES: 2, UNKNOWN: 1, BLOCKED: 0 };

export function parseSwarmSelection(value: string | undefined): SwarmSelection {
  const selection = value ?? "coverage";
  if (
    selection === "coverage" ||
    selection === "first-pass" ||
    selection === "rank-all" ||
    selection === "best-of"
  ) {
    return selection;
  }
  throw new Error("selection must be first-pass|rank-all|best-of|coverage");
}

/** The worker's declared verdict: the last PASS/ISSUES/BLOCKED token, else exit-code derived. */
export function swarmVerdict(output: string, exitCode: number): SwarmVerdict {
  const matches = [...output.matchAll(/\b(PASS|ISSUES|BLOCKED)\b/g)];
  const last = matches.at(-1)?.[1];
  if (last === "PASS" || last === "ISSUES" || last === "BLOCKED") return last;
  return exitCode === 0 ? "UNKNOWN" : "BLOCKED";
}

export interface SwarmSelectionResult {
  readonly ordered: number[];
  readonly winner?: number;
  readonly verdicts: SwarmVerdict[];
}

/** Order results by verdict rank and name the winner the declared race rule selects. */
export function selectSwarmResults(
  results: ReadonlyArray<{ readonly output: string; readonly exitCode: number }>,
  selection: SwarmSelection,
): SwarmSelectionResult {
  const verdicts = results.map((result) => swarmVerdict(result.output, result.exitCode));
  if (selection === "coverage") {
    return { ordered: results.map((_result, index) => index), verdicts };
  }
  let byRank: number[] = [];
  for (const rank of [3, 2, 1, 0]) {
    for (const [index, verdict] of verdicts.entries()) {
      if (VERDICT_RANK[verdict] === rank) byRank = [...byRank, index];
    }
  }
  const winner = selection === "first-pass" ? verdicts.findIndex((v) => v === "PASS") : byRank[0];
  return { ordered: byRank, winner: winner >= 0 ? winner : undefined, verdicts };
}

async function runSwarmWorkers(
  workers: WorkerSpec[],
  cwds: string[],
  parentModel: string,
  ctxCwd: string,
  trustedConfigCwd: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onUpdate: ((update: { content: Array<{ type: string; text: string }>; details: Record<string, unknown> }) => void) | undefined,
): Promise<WorkerResult[]> {
  let doneCount = 0;
  return await mapConcurrent(workers, MAX_CONCURRENCY, async (w, index) => {
    const model =
      w.model ??
      resolveRoleModel("swarm workers", parentModel, 0, trustedConfigCwd) ??
      parentModel;
    const result = await runChildTask(
      {
        task: w.task,
        model,
        cwd: cwds[index],
        role: w.role ?? "general",
        timeoutMs,
      },
      ctxCwd,
      parentModel,
      signal,
    );
    doneCount = doneCount + 1;
    onUpdate?.({
      content: [{ type: "text", text: `${doneCount}/${workers.length} swarm workers done` }],
      details: {},
    });
    return { ...result, cwd: cwds[index] };
  });
}

function formatSwarmResponse(results: WorkerResult[], selection: SwarmSelection) {
  const ranking = selectSwarmResults(results, selection);
  const table = ranking.ordered
    .map(
      (index) =>
        `| ${index + 1} | ${results[index].model} | ${ranking.verdicts[index]} | exit ${results[index].exitCode} | ${results[index].stopReason ?? "-"} | ${results[index].cwd} |`,
    )
    .join("\n");
  const bodies = ranking.ordered
    .map(
      (index) =>
        `### Worker ${index + 1} (${results[index].model}, exit ${results[index].exitCode}, cwd ${results[index].cwd})\n\n${results[index].output}`,
    )
    .join("\n\n---\n\n");
  const winnerLine =
    ranking.winner === undefined
      ? ""
      : `\n\nDeclared rule \`${selection}\`: take worker ${ranking.winner + 1} (${ranking.verdicts[ranking.winner]}).`;

  const report = `## Swarm report (${selection})\n\n| # | model | verdict | exit | stop | cwd |\n|---|-------|---------|------|------|-----|\n${table}${winnerLine}\n\n${bodies}`;
  const capped = capToolOutput(report, { keep: "head", label: "swarm-report" });

  return {
    content: [
      {
        type: "text",
        text: capped.text,
      },
    ],
    details: {
      selection,
      verdicts: ranking.verdicts,
      winner: ranking.winner,
      results,
      concurrencyCap: MAX_CONCURRENCY,
      ...(capped.outputPath ? { fullOutputPath: capped.outputPath } : {}),
    },
  };
}

const SWARM_DESCRIPTION =
  `Fan out N parallel Pi child workers (coverage / race / best-of). Always isolates each worker in a unique worktree (even N=1); omit cwd for auto-alloc. Global child concurrency cap: ${MAX_CONCURRENCY}. Max ${MAX_TASKS} tasks. The aggregate report caps at 50KB / 2000 lines; a truncated report's trailer names the temp file with the full text.`;

const SWARM_PROMPT_GUIDELINES = [
  "Use pstack_swarm for coverage matrices, races, and gauntlets instead of multiple Cursor Task calls.",
  "Each pstack_swarm worker brief must stand alone with goal, scope, verify steps, and PASS/ISSUES/BLOCKED reporting.",
  `pstack_swarm always auto-isolates (even a single worker). Never share the parent dirty cwd. Cap ${MAX_CONCURRENCY} concurrent children globally.`,
];

const SWARM_PARAMETERS = Type.Object({
  workers: Type.Array(
    Type.Object({
      task: Type.String(),
      model: Type.Optional(Type.String()),
      cwd: Type.Optional(Type.String()),
      role: Type.Optional(Type.String()),
    }),
    { minItems: 1, maxItems: MAX_TASKS },
  ),
  selection: Type.Optional(
    StringEnum(["first-pass", "rank-all", "best-of", "coverage"] as const, {
      description: "first-pass | rank-all | best-of | coverage (default)",
    }),
  ),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS })),
});

export function registerSwarm(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_swarm",
    label: "Pstack Swarm",
    description: SWARM_DESCRIPTION,
    promptSnippet: "Parallel pstack workers with aggregated report",
    promptGuidelines: SWARM_PROMPT_GUIDELINES,
    parameters: SWARM_PARAMETERS,
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!ctx.model) throw new Error("pstack_swarm requires an active parent model");
      const parentModel = `${ctx.model.provider}/${ctx.model.id}`;
      const cwds = await ensureAlwaysIsolated(
        ctx.cwd,
        params.workers.map((w, i) => ({ cwd: stripAtPrefix(w.cwd), label: `worker-${i + 1}` })),
      );
      const results = await runSwarmWorkers(
        params.workers,
        cwds,
        parentModel,
        ctx.cwd,
        projectConfigCwd(ctx),
        signal,
        params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        onUpdate,
      );

      const selection = parseSwarmSelection(params.selection);
      return formatSwarmResponse(results, selection);
    },
  });
}
