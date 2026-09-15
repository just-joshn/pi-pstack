/**
 * Pure babysit watchArgv + dynamic loop arm helpers (no ExtensionAPI / typebox).
 */
import { materializeWatchArgv, BABYSIT_WATCH_RECIPES } from "../heartbeat/coalesce.ts";

/** Default babysit recipe when caller omits recipeId (drive → watch-pr). */
export const DEFAULT_BABYSIT_RECIPE = "watch-pr-drive";

export { BABYSIT_WATCH_RECIPES };

export function babysitDynamicLoopHint(
  pr: string,
  recipeId = DEFAULT_BABYSIT_RECIPE,
): {
  recipeId: string;
  watchArgv: string[];
  loopArm: Record<string, unknown>;
} {
  const watchArgv = materializeWatchArgv(recipeId, pr);
  return {
    recipeId,
    watchArgv,
    loopArm: {
      action: "arm",
      mode: "dynamic",
      intervalSeconds: 120,
      maxFires: 40,
      watchArgv,
      prompt: `Babysit frontier PR ${pr.replace(/^#/, "")}: re-read forge state and clear the next blocker.`,
    },
  };
}
