/**
 * pstack_ship / pstack_babysit — gh-only stack-aware land + watch (Shipping/Babysit twins).
 * Prefers skills/poteto-mode/scripts/watch-pr when present.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WATCH_PR = resolve(PACKAGE_ROOT, "skills/poteto-mode/scripts/watch-pr/watch-pr");

export function registerShipping(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_babysit",
    label: "Pstack Babysit",
    description:
      "Watch a GitHub PR via gh (or bundled watch-pr script) until a terminal verdict. Closest Pi twin to Babysit playbook polling.",
    promptSnippet: "Watch PR checks/comments until ready or blocked",
    parameters: Type.Object({
      pr: Type.String({ description: "PR number or URL" }),
      statusOnly: Type.Optional(Type.Boolean()),
      pretty: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal) {
      if (existsSync(WATCH_PR)) {
        const args = [WATCH_PR, params.pr];
        if (params.statusOnly) args.push("--status-only");
        if (params.pretty) args.push("--pretty");
        const result = await pi.exec("bash", args, { signal, timeout: 60 * 60 * 1000 });
        return {
          content: [{ type: "text", text: result.stdout || result.stderr || `(exit ${result.code})` }],
          details: { code: result.code, via: "watch-pr" },
        };
      }
      const pr = params.pr.replace(/^#/, "");
      const result = await pi.exec(
        "gh",
        [
          "pr",
          "view",
          pr,
          "--json",
          "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,url,reviewDecision",
        ],
        { signal },
      );
      return {
        content: [{ type: "text", text: result.stdout || result.stderr }],
        details: { code: result.code, via: "gh" },
      };
    },
  });

  pi.registerTool({
    name: "pstack_ship",
    label: "Pstack Ship",
    description:
      "Stack-aware GitHub land helper: view/merge contiguous green PRs via gh. Closest twin to Shipping playbook (gh-only v1).",
    promptSnippet: "Merge or inspect a green PR stack with gh",
    parameters: Type.Object({
      action: Type.String({ description: "view | merge | stack-status" }),
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
      if (params.action !== "merge") throw new Error("action must be view|merge|stack-status");
      if (!params.pr) throw new Error("pr required for merge");
      const method = params.mergeMethod ?? "squash";
      const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
      const r = await pi.exec("gh", ["pr", "merge", params.pr.replace(/^#/, ""), flag, "--auto"], {
        signal,
      });
      return {
        content: [
          {
            type: "text",
            text: r.stdout || r.stderr || `gh pr merge exited ${r.code}. Parent must verify Shipping playbook independent verdict before arming.`,
          },
        ],
        details: { code: r.code },
      };
    },
  });
}
