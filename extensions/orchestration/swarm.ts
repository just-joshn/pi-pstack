/**
 * pstack_swarm — fan-out N parallel child agents, aggregate one report.
 */
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { capToolOutput } from "../lib/tool-output.ts";
import { stripAtPrefix } from "../lib/paths.ts";
import type { ChildTaskResult } from "../subagents/child-runner.ts";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_TIMEOUT_MS,
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

/**
 * A worker result is the child's own result plus the cwd it ran in. Deriving it
 * from `ChildTaskResult` keeps the two in step: redeclaring the shape here is
 * what let `stopReason` diverge when the child's optionality changed.
 */
type WorkerResult = ChildTaskResult & { cwd: string };

/** One cwd per worker; a missing entry means the allocator returned short. */
function zipWorkers(
  workers: ReadonlyArray<WorkerSpec>,
  cwds: ReadonlyArray<string>,
): Array<{ worker: WorkerSpec; cwd: string }> {
  return workers.map((worker, index) => {
    const cwd = cwds[index];
    if (cwd === undefined) throw new Error(`missing isolated worktree for worker ${index + 1}`);
    return { worker, cwd };
  });
}

export type SwarmSelection = "coverage" | "first-pass" | "rank-all" | "best-of";

/** Schema ceiling for one call; the concurrency cap still bounds how many run at once. */
export const MAX_SWARM_WORKERS = 64;

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
  readonly winner?: number | undefined;
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
  return {
    ordered: byRank,
    winner: winner !== undefined && winner >= 0 ? winner : undefined,
    verdicts,
  };
}

/**
 * Run items in sequential waves of at most `waveSize` concurrent calls, keeping
 * input order. N is the total worker count; the wave shape is what bounds
 * parallelism, so a wave must finish before the next starts.
 */
export async function runInWaves<T, U>(
  items: readonly T[],
  waveSize: number,
  run: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const size = Math.max(1, Math.trunc(waveSize));
  let results: U[] = [];
  for (let start = 0; start < items.length; start += size) {
    const wave = items.slice(start, start + size);
    const completed = await Promise.all(wave.map((item, offset) => run(item, start + offset)));
    results = [...results, ...completed];
  }
  return results;
}

async function runSwarmWorkers(
  workers: WorkerSpec[],
  cwds: string[],
  parentModel: string,
  ctxCwd: string,
  trustedConfigCwd: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
): Promise<WorkerResult[]> {
  const units = zipWorkers(workers, cwds);
  let doneCount = 0;
  return await runInWaves(units, MAX_CONCURRENCY, async (unit) => {
    const model =
      unit.worker.model ??
      resolveRoleModel("swarm workers", parentModel, 0, trustedConfigCwd) ??
      parentModel;
    const result = await runChildTask(
      {
        task: unit.worker.task,
        model,
        cwd: unit.cwd,
        role: unit.worker.role ?? "general",
        timeoutMs,
      },
      ctxCwd,
      parentModel,
      signal,
    );
    doneCount = doneCount + 1;
    onUpdate?.({
      content: [{ type: "text", text: `${doneCount}/${units.length} swarm workers done` }],
      details: {},
    });
    return { ...result, cwd: unit.cwd };
  });
}

function formatSwarmResponse(
  results: WorkerResult[],
  selection: SwarmSelection,
): AgentToolResult<Record<string, unknown>> {
  const ranking = selectSwarmResults(results, selection);
  const ordered = ranking.ordered.flatMap((index) => {
    const result = results[index];
    const verdict = ranking.verdicts[index];
    return result === undefined || verdict === undefined ? [] : [{ index, result, verdict }];
  });
  const table = ordered
    .map(
      ({ index, result, verdict }) =>
        `| ${index + 1} | ${result.model} | ${verdict} | exit ${result.exitCode} | ${result.stopReason ?? "-"} | ${result.cwd} |`,
    )
    .join("\n");
  const bodies = ordered
    .map(
      ({ index, result }) =>
        `### Worker ${index + 1} (${result.model}, exit ${result.exitCode}, cwd ${result.cwd})\n\n${result.output}`,
    )
    .join("\n\n---\n\n");
  const winner = ranking.winner;
  const winnerVerdict = winner === undefined ? undefined : ranking.verdicts[winner];
  const winnerLine =
    winner === undefined || winnerVerdict === undefined
      ? ""
      : `\n\nDeclared rule \`${selection}\`: take worker ${winner + 1} (${winnerVerdict}).`;

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
  `Fan out N parallel Pi child workers (coverage / race / best-of). Always isolates each worker in a unique worktree (even N=1); omit cwd for auto-alloc. Global child concurrency cap: ${MAX_CONCURRENCY}, so workers run in sequential waves of at most ${MAX_CONCURRENCY}. N is the total worker count, up to ${MAX_SWARM_WORKERS} per call. The aggregate report caps at 50KB / 2000 lines; a truncated report's trailer names the temp file with the full text.`;

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
    { minItems: 1, maxItems: MAX_SWARM_WORKERS },
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
