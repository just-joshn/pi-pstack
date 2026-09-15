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
  const mergeProblems = data.mergedAt ? ["already merged"] : [];
  const stateProblems = data.state && data.state !== "OPEN" ? [`state=${data.state}`] : [];
  const status = data.mergeStateStatus ?? "";
  const statusProblems = ["UNSTABLE", "DIRTY", "DRAFT", "BLOCKED", "BEHIND"].includes(status)
    ? [`mergeStateStatus=${status}`]
    : [];
  const checkProblems = (data.statusCheckRollup ?? []).flatMap((c) => {
    const conclusion = (c.conclusion ?? c.state ?? "").toUpperCase();
    if (["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED"].includes(conclusion)) {
      return [`check ${c.name ?? "?"}=${conclusion}`];
    }
    const statusUpper = (c.status ?? "").toUpperCase();
    if (
      !conclusion &&
      (statusUpper === "PENDING" || statusUpper === "IN_PROGRESS" || statusUpper === "QUEUED")
    ) {
      return [`check ${c.name ?? "?"}=${statusUpper}`];
    }
    return [];
  });
  const reviewProblems =
    data.reviewDecision === "CHANGES_REQUESTED"
      ? ["reviewDecision=CHANGES_REQUESTED"]
      : data.reviewDecision === "REVIEW_REQUIRED"
        ? ["reviewDecision=REVIEW_REQUIRED"]
        : [];
  return [...mergeProblems, ...stateProblems, ...statusProblems, ...checkProblems, ...reviewProblems];
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
