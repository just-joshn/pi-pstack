import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { errorMessage, isRecord, parseJson } from "../lib/validation.ts";
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
const mergeReady = (proof: Proof, pr: PullRequestStatus) =>
  !!proof.evidence?.trim() &&
  proof.independent &&
  proof.head === pr.headRefOid &&
  pr.state === "OPEN" &&
  !pr.isDraft &&
  pr.mergeable === "MERGEABLE" &&
  pr.mergeStateStatus === "CLEAN" &&
  checksPass(pr);

type Approved = Proof & { url: string };

export function verifiedPrefix(proofs: Proof[], statuses: PullRequestStatus[]): Approved[] {
  const byNumber = new Map(statuses.map((status) => [status.number, status]));
  const prefix: Approved[] = [];
  for (const proof of proofs) {
    const pr = byNumber.get(proof.number);
    if (!pr || !mergeReady(proof, pr)) break;
    const { number, head, evidence, independent } = proof;
    prefix.push({ number, head, evidence, independent, url: pr.url });
  }
  return prefix;
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
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    ...(signal && { signal }),
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

async function previewPrefix(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  proofs: Proof[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const reads = await Promise.allSettled(
    proofs.map((proof) => fetchPr(pi, ctx, proof.number, signal)),
  );
  signal?.throwIfAborted();
  const statuses = reads.flatMap((read) => (read.status === "fulfilled" ? [read.value] : []));
  const prefix = verifiedPrefix(proofs, statuses);
  const next = reads[prefix.length];
  const unread = proofs[prefix.length];
  const lookupFailure =
    unread && next?.status === "rejected"
      ? { number: unread.number, error: errorMessage(next.reason) }
      : undefined;
  if (!prefix.length)
    fail(
      lookupFailure
        ? `Could not check PR #${lookupFailure.number}: ${lookupFailure.error}`
        : "No verified merge-ready prefix",
    );
  return { prefix, lookupFailure };
}

async function mergePrefix(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prefix: Approved[],
  requireActivePlan: () => void,
  signal?: AbortSignal,
) {
  const merged: { number: number; head: string; url: string }[] = [];
  for (const proof of prefix) {
    const stopped = { merged, stopped: proof.number };
    let fresh;
    try {
      requireActivePlan();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Recheck each approved PR immediately before merging it.
      fresh = await fetchPr(pi, ctx, proof.url, signal);
      requireActivePlan();
    } catch (error) {
      return {
        ...stopped,
        reason: "Could not recheck readiness; merge not attempted",
        error: errorMessage(error),
      };
    }
    if (!mergeReady(proof, fresh)) {
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
        { cwd: ctx.cwd, timeout: 60000, maxBuffer: 1024 * 1024, ...(signal && { signal }) },
      );
      if (r.code !== 0 || r.killed || r.truncated) return { ...uncertain, error: r.stderr };

      // oxlint-disable-next-line eslint/no-await-in-loop -- Confirm the merge before advancing.
      const after = await fetchPr(pi, ctx, proof.url, signal);
      if (after.state !== "MERGED" || after.headRefOid !== proof.head) return uncertain;
      merged.push({ number: proof.number, head: after.headRefOid, url: after.url });
    } catch (error) {
      return { ...uncertain, error: errorMessage(error) };
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
      const requireActivePlan = () => {
        if (!ctx.hasUI || !mergeRoutes.includes(currentRoute() ?? ""))
          fail("Merging requires a shipping or autopilot-full plan and interactive approval");
      };
      requireActivePlan();
      if (new Set(p.proofs.map((proof) => proof.number)).size !== p.proofs.length)
        fail("Duplicate PR");
      const { prefix, lookupFailure } = await previewPrefix(pi, ctx, p.proofs, signal);
      requireActivePlan();
      if (!(await ctx.ui.confirm("Merge these exact PR heads bottom-up?", text(prefix))))
        fail("Merge not authorized");
      signal?.throwIfAborted();
      const outcome = await mergePrefix(pi, ctx, prefix, requireActivePlan, signal);
      const unconfirmed = "unconfirmed" in outcome ? outcome.unconfirmed : undefined;
      return result({
        ...outcome,
        lookupFailure,
        unmerged: p.proofs
          .slice(outcome.merged.length)
          .map((proof) => proof.number)
          .filter((number) => number !== unconfirmed),
      });
    },
  });
}
