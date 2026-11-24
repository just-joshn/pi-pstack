import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isRecord, parseJson } from "../lib/validation.ts";
import { fail, result, text } from "./support.ts";

const checksFields =
  "number,url,headRefOid,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,baseRefName";

export interface Proof {
  number: number;
  head: string;
  evidence: string;
  independent: boolean;
}
interface PullRequestStatus {
  number: number;
  url: string;
  headRefOid: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  statusCheckRollup: { status?: string; conclusion?: string; state?: string }[] | null;
}

const passingConclusions = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const checksPass = (pr: PullRequestStatus) =>
  !!pr.statusCheckRollup?.length &&
  pr.statusCheckRollup.every((check) =>
    check.status === "COMPLETED"
      ? passingConclusions.has(check.conclusion ?? "")
      : check.state === "SUCCESS",
  );
const mergeReady = (proof: Proof, pr: PullRequestStatus | undefined) =>
  !!pr &&
  !!proof.evidence?.trim() &&
  proof.independent &&
  proof.head === pr.headRefOid &&
  pr.state === "OPEN" &&
  !pr.isDraft &&
  pr.mergeable === "MERGEABLE" &&
  pr.mergeStateStatus === "CLEAN" &&
  checksPass(pr);

export function verifiedPrefix<T extends Proof>(proofs: T[], statuses: PullRequestStatus[]): T[] {
  const byNumber = new Map(statuses.map((status) => [status.number, status]));
  const firstUnready = proofs.findIndex((proof) => !mergeReady(proof, byNumber.get(proof.number)));
  return firstUnready < 0 ? proofs : proofs.slice(0, firstUnready);
}

function prUrl(value: unknown, number: number): value is string {
  return (
    typeof value === "string" &&
    /^https:\/\/[a-z0-9.:-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/\d+$/i.test(value) &&
    value.endsWith(`/pull/${number}`)
  );
}

function isStatus(value: unknown, number: number): value is PullRequestStatus {
  return (
    isRecord(value) &&
    value.number === number &&
    prUrl(value.url, number) &&
    typeof value.headRefOid === "string" &&
    /^[0-9a-f]{40}$/i.test(value.headRefOid) &&
    typeof value.state === "string" &&
    typeof value.isDraft === "boolean" &&
    typeof value.mergeable === "string" &&
    typeof value.mergeStateStatus === "string" &&
    (value.statusCheckRollup === null ||
      (Array.isArray(value.statusCheckRollup) &&
        value.statusCheckRollup.every(
          (check: unknown) =>
            isRecord(check) &&
            [check.status, check.conclusion, check.state].every(
              (field) => field === undefined || typeof field === "string",
            ),
        )))
  );
}

async function fetchPr(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  id: number | string,
  signal?: AbortSignal,
) {
  const r = await pi.exec("gh", ["pr", "view", String(id), "--json", checksFields], {
    cwd: ctx.cwd,
    signal,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (r.truncated || r.killed) fail("gh pr view failed: output truncated or process stopped");
  if (r.code !== 0) fail(`gh pr view failed: ${r.stderr}`);
  const payload = parseJson(r.stdout, "gh pr response");
  const number = typeof id === "number" ? id : Number(id.split("/").at(-1));
  if (!isStatus(payload, number) || (typeof id === "string" && payload.url !== id)) {
    fail(`Unexpected GitHub PR response for ${id}`);
  }
  return payload;
}

export const mergeRoutes = ["shipping", "autopilot-full"];

type Approved = Proof & { url: string };
async function mergePrefix(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prefix: Approved[],
  signal?: AbortSignal,
) {
  const merged: { number: number; head: string; url: string }[] = [];
  for (const proof of prefix) {
    const stopped = { merged, stopped: proof.number };
    let fresh;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Recheck each approved PR immediately before merging it.
      fresh = await fetchPr(pi, ctx, proof.url, signal);
    } catch (error) {
      return {
        ...stopped,
        reason: "Could not recheck readiness; merge not attempted",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!verifiedPrefix([proof], [fresh]).length) {
      return { ...stopped, reason: "Head or readiness changed" };
    }

    const uncertain = {
      ...stopped,
      unconfirmed: proof.number,
      reason: "Merge not confirmed; inspect forge state",
    };
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Stack merges must run in order.
      const r = await pi.exec(
        "gh",
        ["pr", "merge", proof.url, "--merge", "--match-head-commit", proof.head],
        { cwd: ctx.cwd, signal, timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      if (r.code !== 0 || r.killed || r.truncated) return { ...uncertain, error: r.stderr };

      // oxlint-disable-next-line eslint/no-await-in-loop -- Confirm the merge before advancing.
      const after = await fetchPr(pi, ctx, proof.url, signal);
      if (after.state !== "MERGED") return uncertain;
      merged.push({ number: proof.number, head: proof.head, url: after.url });
    } catch (error) {
      return { ...uncertain, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { merged, ceiling: prefix.at(-1)?.number };
}

export function registerForge(pi: ExtensionAPI, currentRoute: () => string | undefined) {
  pi.registerTool({
    name: "pstack_pr",
    label: "Pstack PR state",
    description: "Fetch live GitHub PR head and CI state. Requires configured gh. No writes.",
    parameters: Type.Object({ number: Type.Integer({ minimum: 1 }) }),
    async execute(_id, p, signal, _update, ctx) {
      return result(await fetchPr(pi, ctx, p.number, signal));
    },
  });
  pi.registerTool({
    name: "pstack_ship",
    label: "Pstack shipping gate",
    description:
      "Merge an explicitly approved contiguous verified GitHub PR prefix bottom-up. Requires independent evidence per head and fresh green checks, then explicit UI confirmation. Never used for autopilot-stack or Benny.",
    executionMode: "sequential",
    parameters: Type.Object({
      proofs: Type.Array(
        Type.Object({
          number: Type.Integer({ minimum: 1 }),
          head: Type.String(),
          evidence: Type.String(),
          independent: Type.Boolean(),
        }),
        { minItems: 1, maxItems: 25 },
      ),
    }),
    async execute(_id, p, signal, _update, ctx) {
      if (!ctx.hasUI || !mergeRoutes.includes(currentRoute() ?? "")) {
        fail("Merging requires a shipping or autopilot-full plan and interactive approval");
      }
      if (new Set(p.proofs.map((proof) => proof.number)).size !== p.proofs.length)
        fail("Duplicate PR");
      const statuses = await Promise.all(
        p.proofs.map((proof) => fetchPr(pi, ctx, proof.number, signal)),
      );
      const prefix = verifiedPrefix(p.proofs, statuses).map(
        ({ number, head, evidence, independent }, i) => ({
          number,
          head,
          evidence,
          independent,
          url: statuses[i].url,
        }),
      );
      if (!prefix.length) fail("No verified merge-ready prefix");
      if (!(await ctx.ui.confirm("Merge these exact PR heads bottom-up?", text(prefix))))
        fail("Merge not authorized");
      const outcome = await mergePrefix(pi, ctx, prefix, signal);
      const unconfirmed = "unconfirmed" in outcome ? outcome.unconfirmed : undefined;
      return result({
        ...outcome,
        unmerged: p.proofs
          .slice(outcome.merged.length)
          .map((proof) => proof.number)
          .filter((number) => number !== unconfirmed),
      });
    },
  });
}
