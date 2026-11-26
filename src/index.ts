import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { backgroundWorkers, registerBackground } from "./background.ts";
import { registerCatalog } from "./catalog-ui.ts";
import { registerDelegation } from "./delegate.ts";
import { registerForge } from "./forge.ts";
import { activePlan } from "./lib/state.ts";
import { registerModelSetup } from "./models.ts";
import { registerPlan } from "./plan.ts";
import { registerRecords } from "./records.ts";
import { createSession } from "./session.ts";
import { notifier } from "./support.ts";
import { activeWorktrees, registerWorktrees } from "./worktrees.ts";

export default function pstack(pi: ExtensionAPI) {
  const notify = notifier(pi);
  const session = createSession(pi);
  const active = activeWorktrees();
  registerModelSetup(pi, notify);
  registerPlan(pi, session, notify);
  registerCatalog(pi, notify);
  registerRecords(pi, notify);
  registerWorktrees(pi, active);
  const background = backgroundWorkers();
  registerDelegation(pi, active, background);
  registerBackground(pi, background, active);
  registerForge(pi, () => activePlan(session.state())?.route);
}
