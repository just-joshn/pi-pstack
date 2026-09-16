/**
 * pstack_ship / pstack_babysit — gh-only stack-aware land + watch (Shipping/Babysit twins).
 * Prefers skills/poteto-mode/scripts/watch-pr when present.
 * Merge fails closed unless PR gate check passes.
 * Babysit defaults wire concrete watchArgv recipes + dynamic loop guidance.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { capToolOutput } from "../lib/tool-output.ts";
import { execOptions } from "../lib/exec-options.ts";
import {
  evaluateMergeGates,
  MERGE_GATE_FIXTURES,
  type PrGateView,
} from "./gates.ts";
import {
  BABYSIT_WATCH_RECIPES,
  DEFAULT_BABYSIT_RECIPE,
  babysitDynamicLoopHint,
} from "./babysit-recipes.ts";
import { assertBunAvailable, watchPrInvocation } from "../heartbeat/coalesce.ts";
import { evaluateStack, type StackPrView } from "./frontier.ts";

const WATCH_PR_RECIPE_IDS = new Set([
  "watch-pr-drive",
  "watch-pr-status",
  "watch-pr-stack",
  "watch-pr-queued-stack",
]);

export {
  evaluateMergeGates,
  MERGE_GATE_FIXTURES,
  type PrGateView,
} from "./gates.ts";
export {
  DEFAULT_BABYSIT_RECIPE,
  babysitDynamicLoopHint,
  BABYSIT_WATCH_RECIPES,
} from "./babysit-recipes.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WATCH_PR = resolve(PACKAGE_ROOT, "skills/poteto-mode/scripts/watch-pr/watch-pr");

type BabysitDetails = {
  code: number;
  via: string;
  recipeId: string;
  watchArgv: string[];
  loopArm?: unknown;
  fixturesAvailable?: number;
  fullOutputPath?: string;
};

type BabysitResponse = AgentToolResult<BabysitDetails>;

type ShipStackResponse = AgentToolResult<Record<string, unknown>>;

async function executeBabysitWithWatchPr(
  pi: ExtensionAPI,
  prRaw: string,
  params: { statusOnly?: boolean; pretty?: boolean },
  recipeId: string,
  hint: { watchArgv: string[]; loopArm: unknown },
  includeHint: boolean,
  signal: AbortSignal | undefined,
): Promise<BabysitResponse> {
  await assertBunAvailable((command, argv, opts) => pi.exec(command, argv, opts), signal);
  const tailArgs = hint.watchArgv.slice(2); // drop ["bun", <script-path-token>]
  const scriptArgs = params.pretty ? [...tailArgs, "--pretty"] : tailArgs;
  const { command, args } = watchPrInvocation(WATCH_PR, scriptArgs);
  const result = await pi.exec(command, args, execOptions({ signal, timeout: 60 * 60 * 1000 }));
  const hintBlock = includeHint
    ? `\n\n--- pstack_loop dynamic arm (default babysit recipe ${recipeId}) ---\n${JSON.stringify(hint.loopArm, null, 2)}\nwatchArgv=${JSON.stringify(hint.watchArgv)}`
    : "";
  const out = capToolOutput(result.stdout || result.stderr || `(exit ${result.code})`, {
    keep: "tail",
    label: "babysit-watch-pr",
  });
  return {
    content: [
      {
        type: "text",
        text: `${out.text}${hintBlock}`,
      },
    ],
    details: {
      code: result.code,
      via: "watch-pr",
      recipeId,
      watchArgv: hint.watchArgv,
      loopArm: includeHint ? hint.loopArm : undefined,
      ...(out.outputPath ? { fullOutputPath: out.outputPath } : {}),
    },
  };
}

async function executeBabysitWithGhRecipe(
  pi: ExtensionAPI,
  recipeId: string,
  hint: { watchArgv: string[]; loopArm: unknown },
  includeHint: boolean,
  signal: AbortSignal | undefined,
): Promise<BabysitResponse> {
  const [cmd, ...argv] = hint.watchArgv;
  if (cmd === undefined) throw new Error("babysit recipe argv must start with a command");
  const result = await pi.exec(cmd, argv, execOptions({
    signal,
    timeout: recipeId === "gh-checks-watch" ? 60 * 60 * 1000 : 60_000,
  }));
  const hintBlock = includeHint
    ? `\n\n--- pstack_loop dynamic arm ---\n${JSON.stringify(hint.loopArm, null, 2)}`
    : "";
  const out = capToolOutput(result.stdout || result.stderr || `(exit ${result.code})`, {
    keep: "tail",
    label: "babysit-gh-recipe",
  });
  return {
    content: [
      {
        type: "text",
        text: `${out.text}${hintBlock}`,
      },
    ],
    details: {
      code: result.code,
      via: "gh-recipe",
      recipeId,
      watchArgv: hint.watchArgv,
      loopArm: includeHint ? hint.loopArm : undefined,
      ...(out.outputPath ? { fullOutputPath: out.outputPath } : {}),
    },
  };
}

async function executeBabysitWithGhView(
  pi: ExtensionAPI,
  prRaw: string,
  recipeId: string,
  hint: { watchArgv: string[]; loopArm: unknown },
  includeHint: boolean,
  signal: AbortSignal | undefined,
): Promise<BabysitResponse> {
  const result = await pi.exec(
    "gh",
    [
      "pr",
      "view",
      prRaw,
      "--json",
      "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,url,reviewDecision",
    ],
    execOptions({ signal }),
  );
  const hintBlock = includeHint
    ? `\n\n--- pstack_loop dynamic arm (default babysit) ---\n${JSON.stringify(hint.loopArm, null, 2)}\nwatchArgv=${JSON.stringify(hint.watchArgv)}`
    : "";
  const out = capToolOutput(result.stdout || result.stderr || `(exit ${result.code})`, {
    keep: "tail",
    label: "babysit-gh-view",
  });
  return {
    content: [
      {
        type: "text",
        text: `${out.text}${hintBlock}`,
      },
    ],
    details: {
      code: result.code,
      via: "gh",
      recipeId,
      watchArgv: hint.watchArgv,
      loopArm: includeHint ? hint.loopArm : undefined,
      fixturesAvailable: MERGE_GATE_FIXTURES.length,
      ...(out.outputPath ? { fullOutputPath: out.outputPath } : {}),
    },
  };
}

async function handleShipView(
  pi: ExtensionAPI,
  pr: string,
  signal: AbortSignal | undefined,
): Promise<ShipStackResponse> {
  const r = await pi.exec(
    "gh",
    ["pr", "view", pr.replace(/^#/, ""), "--json", "number,title,state,mergedAt,mergeStateStatus,url,statusCheckRollup"],
    execOptions({ signal }),
  );
  const out = capToolOutput(r.stdout || r.stderr, { keep: "tail", label: "ship-view" });
  return { content: [{ type: "text", text: out.text }], details: { code: r.code } };
}

async function fetchStackView(
  pi: ExtensionAPI,
  pr: string,
  signal: AbortSignal | undefined,
): Promise<StackPrView> {
  const clean = pr.replace(/^#/, "");
  const r = await pi.exec(
    "gh",
    [
      "pr",
      "view",
      clean,
      "--json",
      "number,state,mergedAt,mergeStateStatus,title,statusCheckRollup,reviewDecision",
    ],
    execOptions({ signal }),
  );
  if (r.code !== 0) return { number: clean, state: "UNKNOWN" };
  try {
    const view = JSON.parse(r.stdout) as StackPrView;
    return { ...view, number: String(view.number ?? clean) };
  } catch {
    return { number: clean, state: "UNKNOWN" };
  }
}

async function handleShipStackStatus(
  pi: ExtensionAPI,
  prs: string[],
  signal: AbortSignal | undefined,
): Promise<ShipStackResponse> {
  if (!prs.length) throw new Error("stackPrs or pr required");
  let views: StackPrView[] = [];
  for (const pr of prs) {
    views = [...views, await fetchStackView(pi, pr, signal)];
  }
  const status = evaluateStack(views);
  const lines = [
    `stack ${status.verdict}${status.frontier ? ` frontier=#${status.frontier}` : ""}`,
    ...status.rows,
    ...(status.problems.length ? [`frontier blockers: ${status.problems.join("; ")}`] : []),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { verdict: status.verdict, frontier: status.frontier, problems: status.problems },
  };
}

async function handleShipGateCheck(
  pi: ExtensionAPI,
  pr: string,
  signal: AbortSignal | undefined,
): Promise<ShipStackResponse> {
  const gate = await assertMergeGates(pi, pr.replace(/^#/, ""), signal);
  return {
    content: [
      {
        type: "text",
        text: `gate-check PASS\n${JSON.stringify(gate, null, 2)}`,
      },
    ],
    details: { gate },
  };
}

async function handleShipMerge(
  pi: ExtensionAPI,
  pr: string,
  mergeMethod: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ShipStackResponse> {
  const prClean = pr.replace(/^#/, "");
  const gate = await assertMergeGates(pi, prClean, signal);
  const method = mergeMethod ?? "squash";
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
  const r = await pi.exec("gh", ["pr", "merge", prClean, flag], execOptions({ signal }));
  if (r.code !== 0) {
    throw new Error(`gh pr merge failed (fail closed): ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  const merged = capToolOutput(r.stdout || "", { keep: "tail", label: "ship-merge" });
  return {
    content: [
      {
        type: "text",
        text: `Merged PR ${prClean} after gate check (mergeStateStatus=${gate.mergeStateStatus ?? "n/a"}).\n${merged.text}`,
      },
    ],
    details: {
      code: r.code,
      gate,
      ...(merged.outputPath ? { fullOutputPath: merged.outputPath } : {}),
    },
  };
}

async function assertMergeGates(
  pi: ExtensionAPI,
  pr: string,
  signal: AbortSignal | undefined,
): Promise<PrGateView> {
  const r = await pi.exec(
    "gh",
    [
      "pr",
      "view",
      pr,
      "--json",
      "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,reviewDecision,url",
    ],
    execOptions({ signal }),
  );
  if (r.code !== 0) {
    throw new Error(`merge gate check failed (fail closed): cannot view PR — ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  let data: PrGateView;
  try {
    data = JSON.parse(r.stdout) as PrGateView;
  } catch {
    throw new Error("merge gate check failed (fail closed): invalid gh JSON");
  }
  const problems = evaluateMergeGates(data);
  if (problems.length) {
    throw new Error(`merge gate check failed (fail closed): ${problems.join("; ")}`);
  }
  return data;
}

type BabysitParams = {
  pr: string;
  statusOnly?: boolean;
  pretty?: boolean;
  recipeId?: string;
  stackPrs?: string[];
  armLoopHint?: boolean;
};

type ShipParams = {
  action: string;
  pr?: string;
  stackPrs?: string[];
  mergeMethod?: string;
};

function resolveBabysitRecipeId(params: BabysitParams): string {
  if (params.statusOnly === true) return "watch-pr-status";
  if (params.recipeId && params.recipeId in BABYSIT_WATCH_RECIPES) return params.recipeId;
  if (params.recipeId) {
    throw new Error(
      `unknown babysit recipeId '${params.recipeId}'. Known: ${Object.keys(BABYSIT_WATCH_RECIPES).join(", ")}`,
    );
  }
  return DEFAULT_BABYSIT_RECIPE;
}

async function executeBabysit(
  pi: ExtensionAPI,
  params: BabysitParams,
  signal: AbortSignal | undefined,
): Promise<BabysitResponse> {
  const prRaw = params.pr.replace(/^#/, "");
  const recipeId = resolveBabysitRecipeId(params);
  if (recipeId === "watch-pr-queued-stack" && !params.stackPrs?.length) {
    throw new Error("recipeId=watch-pr-queued-stack requires stackPrs (bottom-to-top PR numbers)");
  }
  const hint = babysitDynamicLoopHint(prRaw, recipeId, params.stackPrs);
  const includeHint = params.armLoopHint !== false;

  if (existsSync(WATCH_PR) && WATCH_PR_RECIPE_IDS.has(recipeId)) {
    return await executeBabysitWithWatchPr(pi, prRaw, params, recipeId, hint, includeHint, signal);
  }

  if (recipeId === "gh-checks-watch" || recipeId === "gh-view-json") {
    return await executeBabysitWithGhRecipe(pi, recipeId, hint, includeHint, signal);
  }

  return await executeBabysitWithGhView(pi, prRaw, recipeId, hint, includeHint, signal);
}

async function executeShip(
  pi: ExtensionAPI,
  params: ShipParams,
  signal: AbortSignal | undefined,
): Promise<ShipStackResponse> {
  if (params.action === "view") {
    if (!params.pr) throw new Error("pr required");
    return await handleShipView(pi, params.pr, signal);
  }
  if (params.action === "stack-status") {
    const prs = params.stackPrs ?? (params.pr ? [params.pr] : []);
    return await handleShipStackStatus(pi, prs, signal);
  }
  if (params.action === "gate-check") {
    if (!params.pr) throw new Error("pr required for gate-check");
    return await handleShipGateCheck(pi, params.pr, signal);
  }
  if (params.action !== "merge") throw new Error("action must be view|merge|stack-status|gate-check");
  if (!params.pr) throw new Error("pr required for merge");
  return await handleShipMerge(pi, params.pr, params.mergeMethod, signal);
}

function registerBabysitTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_babysit",
    label: "Pstack Babysit",
    description:
      "Watch a GitHub PR via gh (or bundled watch-pr script) until a terminal verdict. Defaults to concrete watchArgv recipes + pstack_loop mode=dynamic guidance (Cursor local babysit twin). Closest Pi twin to Babysit playbook polling. Command output caps at 50KB / 2000 lines; a truncated result's trailer names the temp file with the full text.",
    promptSnippet: "Watch PR checks/comments until ready or blocked",
    promptGuidelines: [
      "Prefer pstack_babysit recipeId=watch-pr-drive (default) or watch-pr-status / watch-pr-stack / watch-pr-queued-stack / gh-checks-watch / gh-view-json.",
      "pstack_babysit recipeId=watch-pr-queued-stack requires stackPrs (bottom-to-top PR numbers).",
      "The bundled watch-pr recipes pstack_babysit runs go via bun (its declared runtime); bun must be on PATH.",
      "Arm pstack_loop with the loopArm pstack_babysit returns (mode=dynamic + watchArgv) for settle+watcher composite babysit.",
      "Never merge from pstack_babysit; route land/ship to pstack_ship / shipping playbook.",
    ],
    parameters: Type.Object({
      pr: Type.String({ description: "PR number or URL" }),
      statusOnly: Type.Optional(Type.Boolean()),
      pretty: Type.Optional(Type.Boolean()),
      recipeId: Type.Optional(
        StringEnum(Object.keys(BABYSIT_WATCH_RECIPES), {
          description: `Concrete watchArgv recipe: ${Object.keys(BABYSIT_WATCH_RECIPES).join(" | ")} (default ${DEFAULT_BABYSIT_RECIPE}; statusOnly forces watch-pr-status)`,
        }),
      ),
      stackPrs: Type.Optional(
        Type.Array(Type.String(), {
          description: "Bottom-to-top PR numbers, required by recipeId=watch-pr-queued-stack",
        }),
      ),
      armLoopHint: Type.Optional(
        Type.Boolean({
          description:
            "If true (default), include pstack_loop mode=dynamic + watchArgv arm payload in the response details.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      return await executeBabysit(pi, params, signal);
    },
  });
}

function registerShipTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_ship",
    label: "Pstack Ship",
    description:
      "Stack-aware GitHub land helper: view/merge contiguous green PRs via gh. Merge runs a real gate check and fails closed if unmet (not a notify toast). Command output caps at 50KB / 2000 lines; a truncated result's trailer names the temp file with the full text.",
    promptSnippet: "Merge or inspect a green PR stack with gh",
    parameters: Type.Object({
      action: StringEnum(["view", "merge", "stack-status", "gate-check"] as const, {
        description: "view | merge | stack-status | gate-check",
      }),
      pr: Type.Optional(Type.String()),
      stackPrs: Type.Optional(Type.Array(Type.String(), { description: "Bottom-to-top PR numbers" })),
      mergeMethod: Type.Optional(
        StringEnum(["squash", "merge", "rebase"] as const, {
          description: "squash | merge | rebase",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      return await executeShip(pi, params, signal);
    },
  });
}

export function registerShipping(pi: ExtensionAPI): void {
  registerBabysitTool(pi);
  registerShipTool(pi);
}
