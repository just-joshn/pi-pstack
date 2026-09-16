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

/** Bundled watch-pr is TypeScript run by its declared bun shebang; never exec it via bash. */
const WATCH_PR_SCRIPT = "skills/poteto-mode/scripts/watch-pr/watch-pr";

/** Command + args to invoke the bundled watch-pr script (bun, not the shell). */
export function watchPrInvocation(scriptPath: string, args: string[]): { command: string; args: string[] } {
  return { command: "bun", args: [scriptPath, ...args] };
}

/**
 * Confirm bun is resolvable before spawning the watcher. `execFn` is pi.exec
 * (or a fake in tests); pi.exec swallows spawn ENOENT into a bare non-zero
 * exit rather than throwing, so a precheck is the only way to name the real
 * cause instead of a silent empty-output failure.
 */
export async function assertBunAvailable(
  execFn: (command: string, args: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<{ code: number }>,
  signal?: AbortSignal,
): Promise<void> {
  const check = await execFn("bun", ["--version"], { signal, timeout: 10_000 });
  if (check.code !== 0) {
    throw new Error(
      "bun is required to run the bundled watch-pr script but was not found on PATH (checked `bun --version`). Install bun (https://bun.sh) or use a gh-* babysit recipe instead.",
    );
  }
}

/** Concrete babysit watchArgv recipes (documented + tested). watch-pr-* run through bun; gh-* run gh directly. */
export const BABYSIT_WATCH_RECIPES: Record<
  string,
  { description: string; argvTemplate: string[] }
> = {
  "watch-pr-status": {
    description: "Bundled watch-pr status-only (GitHub)",
    argvTemplate: ["bun", WATCH_PR_SCRIPT, "--pr", "<pr>", "--status-only"],
  },
  "watch-pr-drive": {
    description: "Bundled watch-pr until terminal verdict (drive mode)",
    argvTemplate: ["bun", WATCH_PR_SCRIPT, "--pr", "<pr>"],
  },
  "watch-pr-stack": {
    description: "Bundled watch-pr across the connected open stack",
    argvTemplate: ["bun", WATCH_PR_SCRIPT, "--stack", "--pr", "<pr>"],
  },
  "watch-pr-queued-stack": {
    description: "Bundled watch-pr across a frozen bottom-to-top queued stack",
    argvTemplate: ["bun", WATCH_PR_SCRIPT, "--queued-stack", "--stack-prs", "<stackPrs>"],
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

function sanitizePrToken(n: string, label: string): string {
  const safe = n.replace(/^#/, "");
  if (!safe || safe.startsWith("-") || /\s/.test(safe)) {
    throw new Error(`invalid ${label} for watchArgv`);
  }
  return safe;
}

export function materializeWatchArgv(
  recipeId: string,
  pr: string,
  opts?: { stackPrs?: string[] },
): string[] {
  const recipe = BABYSIT_WATCH_RECIPES[recipeId];
  if (!recipe) throw new Error(`unknown babysit watch recipe: ${recipeId}`);
  const safePr = sanitizePrToken(pr, "pr");
  const needsStackPrs = recipe.argvTemplate.includes("<stackPrs>");
  const stackPrsToken = needsStackPrs
    ? (opts?.stackPrs ?? []).map((n) => sanitizePrToken(n, "stackPrs entry")).join(",")
    : undefined;
  if (needsStackPrs && !stackPrsToken) {
    throw new Error(`${recipeId} requires a non-empty stackPrs list (bottom-to-top PR numbers)`);
  }
  return recipe.argvTemplate.map((p) => {
    if (p === "<pr>") return safePr;
    if (p === "<stackPrs>") return stackPrsToken as string;
    return p;
  });
}
