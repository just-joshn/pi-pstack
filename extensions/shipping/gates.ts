/**
 * Pure merge-gate evaluation (no ExtensionAPI / typebox).
 */
export interface PrGateView {
  state?: string;
  mergedAt?: string | null;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<{
    name?: string;
    state?: string;
    conclusion?: string | null;
    status?: string;
  }>;
}


/** Pure gate evaluation (exported for tests). */
export function evaluateMergeGates(data: PrGateView): string[] {
  const problems: string[] = [];
  if (data.mergedAt) problems.push("already merged");
  if (data.state && data.state !== "OPEN") problems.push(`state=${data.state}`);
  const status = data.mergeStateStatus ?? "";
  if (["UNSTABLE", "DIRTY", "DRAFT"].includes(status)) {
    problems.push(`mergeStateStatus=${status}`);
  }
  for (const c of data.statusCheckRollup ?? []) {
    const conclusion = (c.conclusion ?? c.state ?? "").toUpperCase();
    if (["FAILURE", "CANCELLED", "TIMED_OUT"].includes(conclusion)) {
      problems.push(`check ${c.name ?? "?"}=${conclusion}`);
    }
  }
  if (data.reviewDecision === "CHANGES_REQUESTED") {
    problems.push("reviewDecision=CHANGES_REQUESTED");
  }
  return problems;
}

