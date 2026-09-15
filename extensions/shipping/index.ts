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

export function registerShipping(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_babysit",
    label: "Pstack Babysit",
    description:
      "Watch a GitHub PR via gh (or bundled watch-pr script) until a terminal verdict. Defaults to concrete watchArgv recipes + pstack_loop mode=dynamic guidance (Cursor local babysit twin). Closest Pi twin to Babysit playbook polling.",
    promptSnippet: "Watch PR checks/comments until ready or blocked",
    promptGuidelines: [
      "Prefer recipeId=watch-pr-drive (default) or watch-pr-status / gh-checks-watch / gh-view-json.",
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
      armLoopHint: Type.Optional(
        Type.Boolean({
          description:
            "If true (default), include pstack_loop mode=dynamic + watchArgv arm payload in the response details.",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const prRaw = params.pr.replace(/^#/, "");
      const recipeId =
        params.statusOnly === true
          ? "watch-pr-status"
          : params.recipeId && params.recipeId in BABYSIT_WATCH_RECIPES
            ? params.recipeId
            : params.recipeId
              ? (() => {
                  throw new Error(
                    `unknown babysit recipeId '${params.recipeId}'. Known: ${Object.keys(BABYSIT_WATCH_RECIPES).join(", ")}`,
                  );
                })()
              : DEFAULT_BABYSIT_RECIPE;
      const hint = babysitDynamicLoopHint(prRaw, recipeId);
      const includeHint = params.armLoopHint !== false;

      if (existsSync(WATCH_PR) && (recipeId === "watch-pr-drive" || recipeId === "watch-pr-status")) {
        const args = [WATCH_PR, prRaw];
        if (params.statusOnly || recipeId === "watch-pr-status") args.push("--status-only");
        if (params.pretty) args.push("--pretty");
        const result = await pi.exec("bash", args, { signal, timeout: 60 * 60 * 1000 });
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

      // Fallback: materialize recipe argv via gh / one-shot
      if (recipeId === "gh-checks-watch" || recipeId === "gh-view-json") {
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
    },
  });

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
      if (params.action === "view") {
        if (!params.pr) throw new Error("pr required");
        const r = await pi.exec(
          "gh",
          ["pr", "view", params.pr.replace(/^#/, ""), "--json", "number,title,state,mergedAt,mergeStateStatus,url,statusCheckRollup"],
          { signal },
        );
        return { content: [{ type: "text", text: r.stdout || r.stderr }], details: { code: r.code } };
      }
      if (params.action === "stack-status") {
        const prs = params.stackPrs ?? (params.pr ? [params.pr] : []);
        if (!prs.length) throw new Error("stackPrs or pr required");
        const chunks: string[] = [];
        for (const pr of prs) {
          const r = await pi.exec(
            "gh",
            ["pr", "view", pr.replace(/^#/, ""), "--json", "number,state,mergedAt,mergeStateStatus,title"],
            { signal },
          );
          chunks.push(r.stdout || `PR ${pr}: ${r.stderr}`);
        }
        return { content: [{ type: "text", text: chunks.join("\n") }], details: {} };
      }
      if (params.action === "gate-check") {
        if (!params.pr) throw new Error("pr required for gate-check");
        const gate = await assertMergeGates(pi, params.pr.replace(/^#/, ""), signal);
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
      if (params.action !== "merge") throw new Error("action must be view|merge|stack-status|gate-check");
      if (!params.pr) throw new Error("pr required for merge");
      const pr = params.pr.replace(/^#/, "");
      const gate = await assertMergeGates(pi, pr, signal);
      const method = params.mergeMethod ?? "squash";
      const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
      const r = await pi.exec("gh", ["pr", "merge", pr, flag], {
        signal,
      });
      if (r.code !== 0) {
        throw new Error(`gh pr merge failed (fail closed): ${r.stderr || r.stdout || `exit ${r.code}`}`);
      }
      return {
        content: [
          {
            type: "text",
            text: `Merged PR ${pr} after gate check (mergeStateStatus=${gate.mergeStateStatus ?? "n/a"}).\n${r.stdout || ""}`,
          },
        ],
        details: { code: r.code, gate },
      };
    },
  });
}
