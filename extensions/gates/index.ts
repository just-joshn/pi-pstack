/**
 * Gates: real pre-ship gate check (not notify-only).
 * Invokes the same criteria as pstack_ship merge; fails closed on unmet gates.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PRData = {
  state?: string;
  mergedAt?: string | null;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<{ name?: string; state?: string; conclusion?: string | null }>;
  url?: string;
  title?: string;
};

function collectGateProblems(data: PRData): string[] {
  const initial: string[] = [];
  const afterMerged = data.mergedAt ? [...initial, "already merged"] : initial;
  const afterState =
    data.state && data.state !== "OPEN" ? [...afterMerged, `state=${data.state}`] : afterMerged;
  const afterMergeState = ["UNSTABLE", "DIRTY", "DRAFT"].includes(data.mergeStateStatus ?? "")
    ? [...afterState, `mergeStateStatus=${data.mergeStateStatus}`]
    : afterState;
  
  const checkProblems = (data.statusCheckRollup ?? []).flatMap((c) => {
    const conclusion = (c.conclusion ?? c.state ?? "").toUpperCase();
    return ["FAILURE", "CANCELLED", "TIMED_OUT"].includes(conclusion)
      ? [`check ${c.name ?? "?"}=${conclusion}`]
      : [];
  });
  
  const afterChecks = [...afterMergeState, ...checkProblems];
  return data.reviewDecision === "CHANGES_REQUESTED"
    ? [...afterChecks, "reviewDecision=CHANGES_REQUESTED"]
    : afterChecks;
}

export function registerGates(pi: ExtensionAPI): void {
  pi.registerCommand("pstack-gates", {
    description: "Run a real pre-ship gate check for a PR number (fail closed). Usage: /pstack-gates <pr>",
    handler: async (args, ctx) => {
      const pr = args.trim().replace(/^#/, "");
      if (!pr) {
        ctx.ui.notify(
          "Usage: /pstack-gates <pr>. Also run /skill:unslop → /skill:no-comments → prove-it-works.",
          "error",
        );
        return;
      }
      const r = await pi.exec(
        "gh",
        [
          "pr",
          "view",
          pr,
          "--json",
          "state,mergedAt,mergeStateStatus,statusCheckRollup,reviewDecision,url,title",
        ],
        {},
      );
      if (r.code !== 0) {
        ctx.ui.notify(`Gate check FAILED (fail closed): cannot view PR — ${r.stderr || r.stdout}`, "error");
        return;
      }
      let data: PRData;
      try {
        data = JSON.parse(r.stdout);
      } catch {
        ctx.ui.notify("Gate check FAILED (fail closed): invalid gh JSON", "error");
        return;
      }
      const problems = collectGateProblems(data);
      if (problems.length) {
        ctx.ui.notify(`Gate check FAILED (fail closed): ${problems.join("; ")}`, "error");
        pi.sendUserMessage(
          `pstack-gates FAIL for PR ${pr}: ${problems.join("; ")}. Do not ship. Fix gates, then re-run /pstack-gates ${pr}. Also: unslop → no-comments → prove-it-works.`,
        );
        return;
      }
      ctx.ui.notify(`Gate check PASS for PR ${pr} (${data.mergeStateStatus ?? "n/a"})`, "info");
      pi.sendUserMessage(
        `pstack-gates PASS for PR ${pr} (${data.title ?? ""}) ${data.url ?? ""}. Still run unslop → no-comments → prove-it-works on the real artifact before merge.`,
      );
    },
  });
}
