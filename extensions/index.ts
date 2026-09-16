/**
 * pi-pstack extension entry. Composition root for poteto-mode and orchestration tools.
 * No Cursor SDKs. No pi-subagents / tintinweb deps.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgents } from "./agents/index.ts";
import { registerDecisionLog } from "./decision-log/index.ts";
import { registerGates } from "./gates/index.ts";
import { registerModels } from "./models/index.ts";
import { registerOrchestration } from "./orchestration/index.ts";
import { registerSpawn } from "./subagents/index.ts";
import { registerWorktree } from "./worktree/index.ts";
import { registerHeartbeat } from "./heartbeat/index.ts";
import { registerLoopController } from "./loop/controller.ts";
import { registerCompanions } from "./companions/index.ts";
import { registerSessions } from "./sessions/index.ts";
import { registerShipping } from "./shipping/index.ts";
import { registerBenny } from "./benny/index.ts";
import { registerPiOnlyCommands, registerSkillCommands } from "./commands/skill-commands.ts";
import { createPotetoRuntime } from "./poteto-state/index.ts";
import { createReadonlyRuntime, type ReadonlyRuntime } from "./readonly-state/index.ts";
import type { EffectContext } from "./effects.ts";

export default function piPstack(pi: ExtensionAPI) {
  // Poteto registers first so its before_agent_start runs before the readonly
  // section is appended, matching the original single-handler composition order.
  let readonlyRuntime: ReadonlyRuntime | undefined;
  createPotetoRuntime(pi, {
    armReadonly: (ctx: EffectContext, reason: string) => readonlyRuntime?.setEnabled(true, ctx, reason),
    releaseReadonly: (ctx: EffectContext) => readonlyRuntime?.releasePlaybookArm(ctx),
  });
  readonlyRuntime = createReadonlyRuntime(pi);

  registerSkillCommands(pi);
  registerPiOnlyCommands(pi);
  registerSpawn(pi);
  registerAgents(pi);
  registerOrchestration(pi);
  registerModels(pi);
  registerDecisionLog(pi);
  registerGates(pi);
  registerWorktree(pi);
  registerHeartbeat(pi);
  registerLoopController(pi);
  registerCompanions(pi);
  registerSessions(pi);
  registerShipping(pi);
  registerBenny(pi);
}
