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
  // BLOCKED / BEHIND are soft warnings that still fail-closed for land
  if (status === "BLOCKED" || status === "BEHIND") {
    problems.push(`mergeStateStatus=${status}`);
  }
  for (const c of data.statusCheckRollup ?? []) {
    const conclusion = (c.conclusion ?? c.state ?? "").toUpperCase();
    if (["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED"].includes(conclusion)) {
      problems.push(`check ${c.name ?? "?"}=${conclusion}`);
    }
    // Pending/in-progress checks also block merge (fail closed)
    const statusUpper = (c.status ?? "").toUpperCase();
    if (
      !conclusion &&
      (statusUpper === "PENDING" || statusUpper === "IN_PROGRESS" || statusUpper === "QUEUED")
    ) {
      problems.push(`check ${c.name ?? "?"}=${statusUpper}`);
    }
  }
  if (data.reviewDecision === "CHANGES_REQUESTED") {
    problems.push("reviewDecision=CHANGES_REQUESTED");
  }
  if (data.reviewDecision === "REVIEW_REQUIRED") {
    problems.push("reviewDecision=REVIEW_REQUIRED");
  }
  return problems;
}

/** Fixture matrix for verify scripts (id → view → expectProblems substring[]). */
export const MERGE_GATE_FIXTURES: Array<{
  id: string;
  view: PrGateView;
  expectPass: boolean;
  expectSubstrings?: string[];
}> = [
  {
    id: "clean-approved-success",
    view: {
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
    },
    expectPass: true,
  },
  {
    id: "dirty-blocks",
    view: {
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "DIRTY",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
    },
    expectPass: false,
    expectSubstrings: ["DIRTY"],
  },
  {
    id: "changes-requested",
    view: {
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
    },
    expectPass: false,
    expectSubstrings: ["CHANGES_REQUESTED"],
  },
  {
    id: "check-failure",
    view: {
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }],
    },
    expectPass: false,
    expectSubstrings: ["FAILURE"],
  },
  {
    id: "already-merged",
    view: {
      state: "MERGED",
      mergedAt: "2026-01-01T00:00:00Z",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollup: [],
    },
    expectPass: false,
    expectSubstrings: ["already merged", "MERGED"],
  },
  {
    id: "draft-blocks",
    view: {
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "DRAFT",
      reviewDecision: null,
      statusCheckRollup: [],
    },
    expectPass: false,
    expectSubstrings: ["DRAFT"],
  },
  {
    id: "pending-check-blocks",
    view: {
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ name: "ci", status: "PENDING", conclusion: null }],
    },
    expectPass: false,
    expectSubstrings: ["PENDING"],
  },
  {
    id: "review-required",
    view: {
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      reviewDecision: "REVIEW_REQUIRED",
      statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
    },
    expectPass: false,
    expectSubstrings: ["REVIEW_REQUIRED"],
  },
  {
    id: "unstable-blocks",
    view: {
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "UNSTABLE",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
    },
    expectPass: false,
    expectSubstrings: ["UNSTABLE"],
  },
  {
    id: "closed-state",
    view: {
      state: "CLOSED",
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollup: [],
    },
    expectPass: false,
    expectSubstrings: ["CLOSED"],
  },
];
