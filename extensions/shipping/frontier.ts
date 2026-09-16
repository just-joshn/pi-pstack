/**
 * Stack frontier: the lowest unmerged PR in a frozen bottom-to-top list is the
 * only one that matters until it merges. ADVANCE when it is merge-ready,
 * WAITING when it is blocked, COMPLETE when every PR has merged.
 */
import { evaluateMergeGates, type PrGateView } from "./gates.ts";

export interface StackPrView extends PrGateView {
  number: string;
  title?: string;
}

export type StackVerdict = "COMPLETE" | "ADVANCE" | "WAITING";

export interface StackStatus {
  readonly verdict: StackVerdict;
  readonly frontier?: string;
  readonly problems: string[];
  readonly rows: string[];
}

export function evaluateStack(views: readonly StackPrView[]): StackStatus {
  const rows = views.map(
    (view) => `${view.number} state=${view.state ?? "?"} mergeStateStatus=${view.mergeStateStatus ?? "?"}`,
  );
  const frontier = views.find((view) => view.state !== "MERGED" && !view.mergedAt);
  if (!frontier) return { verdict: "COMPLETE", problems: [], rows };
  const problems = evaluateMergeGates(frontier);
  return {
    verdict: problems.length ? "WAITING" : "ADVANCE",
    frontier: frontier.number,
    problems,
    rows,
  };
}
