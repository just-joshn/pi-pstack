/**
 * pstack_ship / pstack_babysit — gh-only stack-aware land + watch (Shipping/Babysit twins).
 * Prefers skills/poteto-mode/scripts/watch-pr when present.
 * Merge fails closed unless PR gate check passes.
 * Babysit defaults wire concrete watchArgv recipes + dynamic loop guidance.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

type BabysitResponse = {
  content: Array<{ type: string; text: string }>;
  details: {
    code: number;
    via: string;
    recipeId: string;
    watchArgv: string[];
    loopArm?: unknown;
    fixturesAvailable?: number;
  };
};

type ShipStackResponse = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};

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
  const result = await pi.exec(command, args, { signal, timeout: 60 * 60 * 1000 });
  const hintBlock = includeHint
    ? `\n\n--- pstack_loop dynamic arm (default babysit recipe ${recipeId}) ---\n${JSON.stringify(hint.loopArm, null, 2)}\nwatchArgv=${JSON.stringify(hint.watchArgv)}`
    : "";
  return {
    content: [
      {
        type: "text",
        text: `${result.stdout || result.stderr || `(exit ${result.code})`}${hintBlock}`,
      },
    ],
    details: {
      code: result.code,
      via: "watch-pr",
      recipeId,
      watchArgv: hint.watchArgv,
      loopArm: includeHint ? hint.loopArm : undefined,
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
  const result = await pi.exec(cmd, argv, {
    signal,
    timeout: recipeId === "gh-checks-watch" ? 60 * 60 * 1000 : 60_000,
  });
  const hintBlock = includeHint
    ? `\n\n--- pstack_loop dynamic arm ---\n${JSON.stringify(hint.loopArm, null, 2)}`
    : "";
  return {
    content: [
      {
        type: "text",
        text: `${result.stdout || result.stderr || `(exit ${result.code})`}${hintBlock}`,
      },
    ],
    details: {
      code: result.code,
      via: "gh-recipe",
      recipeId,
      watchArgv: hint.watchArgv,
      loopArm: includeHint ? hint.loopArm : undefined,
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
    { signal },
  );
  const hintBlock = includeHint
    ? `\n\n--- pstack_loop dynamic arm (default babysit) ---\n${JSON.stringify(hint.loopArm, null, 2)}\nwatchArgv=${JSON.stringify(hint.watchArgv)}`
    : "";
  return {
    content: [
      {
        type: "text",
        text: `${result.stdout || result.stderr}${hintBlock}`,
      },
    ],
    details: {
      code: result.code,
      via: "gh",
      recipeId,
      watchArgv: hint.watchArgv,
      loopArm: includeHint ? hint.loopArm : undefined,
      fixturesAvailable: MERGE_GATE_FIXTURES.length,
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
    { signal },
  );
  return { content: [{ type: "text", text: r.stdout || r.stderr }], details: { code: r.code } };
}

async function handleShipStackStatus(
  pi: ExtensionAPI,
  prs: string[],
  signal: AbortSignal | undefined,
): Promise<ShipStackResponse> {
  if (!prs.length) throw new Error("stackPrs or pr required");
  let chunks: string[] = [];
  for (const pr of prs) {
    const r = await pi.exec(
      "gh",
      ["pr", "view", pr.replace(/^#/, ""), "--json", "number,state,mergedAt,mergeStateStatus,title"],
      { signal },
    );
    chunks = [...chunks, r.stdout || `PR ${pr}: ${r.stderr}`];
  }
  return { content: [{ type: "text", text: chunks.join("\n") }], details: {} };
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
  const r = await pi.exec("gh", ["pr", "merge", prClean, flag], {
    signal,
  });
  if (r.code !== 0) {
    throw new Error(`gh pr merge failed (fail closed): ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  return {
    content: [
      {
        type: "text",
        text: `Merged PR ${prClean} after gate check (mergeStateStatus=${gate.mergeStateStatus ?? "n/a"}).\n${r.stdout || ""}`,
      },
    ],
    details: { code: r.code, gate },
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
    { signal },
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
      "Watch a GitHub PR via gh (or bundled watch-pr script) until a terminal verdict. Defaults to concrete watchArgv recipes + pstack_loop mode=dynamic guidance (Cursor local babysit twin). Closest Pi twin to Babysit playbook polling.",
    promptSnippet: "Watch PR checks/comments until ready or blocked",
    promptGuidelines: [
      "Prefer recipeId=watch-pr-drive (default) or watch-pr-status / watch-pr-stack / watch-pr-queued-stack / gh-checks-watch / gh-view-json.",
      "watch-pr-queued-stack requires stackPrs (bottom-to-top PR numbers).",
      "The bundled watch-pr recipes run via bun (its declared runtime); bun must be on PATH.",
      "Arm pstack_loop with the returned loopArm (mode=dynamic + watchArgv) for settle+watcher composite babysit.",
      "Never merge from babysit — route land/ship to pstack_ship / shipping playbook.",
    ],
    parameters: Type.Object({
      pr: Type.String({ description: "PR number or URL" }),
      statusOnly: Type.Optional(Type.Boolean()),
      pretty: Type.Optional(Type.Boolean()),
      recipeId: Type.Optional(
        Type.String({
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
      "Stack-aware GitHub land helper: view/merge contiguous green PRs via gh. Merge runs a real gate check and fails closed if unmet (not a notify toast).",
    promptSnippet: "Merge or inspect a green PR stack with gh",
    parameters: Type.Object({
      action: Type.String({ description: "view | merge | stack-status | gate-check" }),
      pr: Type.Optional(Type.String()),
      stackPrs: Type.Optional(Type.Array(Type.String(), { description: "Bottom-to-top PR numbers" })),
      mergeMethod: Type.Optional(Type.String({ description: "squash | merge | rebase" })),
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
