/**
 * Pure coalesce / lifecycle helpers for pstack_loop (unit-testable without ExtensionAPI).
 */
export const DYNAMIC_COALESCE_MS = 2_500;

export interface CoalesceState {
  lastFireAt: number;
  fires: number;
  maxFires: number;
  armed: boolean;
}

export type FireDecision =
  | { action: "coalesce" }
  | { action: "stop"; fires: number }
  | { action: "fire"; fires: number; reason: string };

/** Decide whether a dynamic (or any) loop should fire, coalesce, or stop. */
export function decideFire(
  state: CoalesceState,
  reason: string,
  now: number,
  coalesceMs: number = DYNAMIC_COALESCE_MS,
  mode: "interval" | "watcher" | "settle" | "dynamic" = "dynamic",
): FireDecision {
  if (!state.armed) return { action: "coalesce" }; // treat as no-op
  if (
    mode === "dynamic" &&
    state.lastFireAt > 0 &&
    now - state.lastFireAt < coalesceMs
  ) {
    return { action: "coalesce" };
  }
  const nextFires = state.fires + 1;
  if (nextFires > state.maxFires) {
    return { action: "stop", fires: nextFires };
  }
  return { action: "fire", fires: nextFires, reason };
}

/** Whether agent_settled should skip arming settle timer (inside coalesce window). */
export function shouldSkipSettleArm(
  lastFireAt: number,
  now: number,
  coalesceMs: number = DYNAMIC_COALESCE_MS,
): boolean {
  return lastFireAt > 0 && now - lastFireAt < coalesceMs;
}

/** Apply a successful fire onto mutable state. */
export function applyFire(state: CoalesceState, now: number): void {
  state.fires += 1;
  state.lastFireAt = now;
}

/** Clear/disarm (session_shutdown twin). */
export function clearLoopState(state: CoalesceState): void {
  state.armed = false;
}

/** Concrete babysit watchArgv recipes (documented + tested). */
export const BABYSIT_WATCH_RECIPES: Record<
  string,
  { description: string; argvTemplate: string[] }
> = {
  "watch-pr-status": {
    description: "Bundled watch-pr status-only (GitHub)",
    argvTemplate: [
      "bash",
      "skills/poteto-mode/scripts/watch-pr/watch-pr",
      "<pr>",
      "--status-only",
    ],
  },
  "watch-pr-drive": {
    description: "Bundled watch-pr until terminal verdict (drive mode)",
    argvTemplate: ["bash", "skills/poteto-mode/scripts/watch-pr/watch-pr", "<pr>"],
  },
  "gh-checks-watch": {
    description: "gh pr checks --watch fallback",
    argvTemplate: ["gh", "pr", "checks", "<pr>", "--watch"],
  },
  "gh-view-json": {
    description: "One-shot gh pr view JSON (check mode)",
    argvTemplate: [
      "gh",
      "pr",
      "view",
      "<pr>",
      "--json",
      "state,mergeStateStatus,statusCheckRollup,reviewDecision",
    ],
  },
};

export function materializeWatchArgv(recipeId: string, pr: string): string[] {
  const recipe = BABYSIT_WATCH_RECIPES[recipeId];
  if (!recipe) throw new Error(`unknown babysit watch recipe: ${recipeId}`);
  const safePr = pr.replace(/^#/, "");
  if (!safePr || safePr.startsWith("-") || /\s/.test(safePr)) {
    throw new Error("invalid pr for watchArgv");
  }
  return recipe.argvTemplate.map((p) => (p === "<pr>" ? safePr : p));
}
