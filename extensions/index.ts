/**
 * pi-pstack extension entry — composition root for poteto-mode + orchestration tools.
 * Stage 3: split state machines into feature modules (poteto-state, readonly-state).
 * No Cursor SDKs. No pi-subagents / tintinweb deps.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDecisionLog } from "./decision-log/index.ts";
import { registerGates } from "./gates/index.ts";
import { registerModels } from "./models/index.ts";
import { registerOrchestration } from "./orchestration/index.ts";
import { registerSpawn } from "./subagents/index.ts";
import { registerWorktree } from "./worktree/index.ts";
import { registerHeartbeat } from "./heartbeat/index.ts";
import { registerCompanions } from "./companions/index.ts";
import { registerSessions } from "./sessions/index.ts";
import { registerShipping } from "./shipping/index.ts";
import { registerBenny } from "./benny/index.ts";
import { registerPiOnlyCommands, registerSkillCommands } from "./commands/skill-commands.ts";
import { createPotetoRuntime } from "./poteto-state/index.ts";
import { createReadonlyRuntime } from "./readonly-state/index.ts";
import type { EffectContext } from "./effects.ts";

export default function piPstack(pi: ExtensionAPI) {
  const readonlyRuntime = createReadonlyRuntime(pi);
  const potetoRuntime = createPotetoRuntime(pi, {
    armReadonly: (ctx: EffectContext, reason: string) => {
      readonlyRuntime.setEnabled(true, ctx, reason);
    },
  });

  registerSkillCommands(pi);
  registerPiOnlyCommands(pi);
  registerSpawn(pi);
  registerOrchestration(pi);
  registerModels(pi);
  registerDecisionLog(pi);
  registerGates(pi);
  registerWorktree(pi);
  registerHeartbeat(pi);
  registerCompanions(pi);
  registerSessions(pi);
  registerShipping(pi);
  registerBenny(pi);
}
