import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { activePlan } from "../lib/state.ts";
import { registerCatalog } from "./catalog-ui.ts";
import { registerDelegation } from "./delegate.ts";
import { registerForge } from "./forge.ts";
import { registerModelSetup } from "./models.ts";
import { registerPlan } from "./plan.ts";
import { registerRecords } from "./records.ts";
import { createSession } from "./session.ts";
import { notifier } from "./support.ts";
import { registerWorktrees } from "./worktrees.ts";

export default function pstack(pi: ExtensionAPI) {
  const notify = notifier(pi);
  const session = createSession(pi);
  const activeWorktrees = new Set<string>();
  registerModelSetup(pi, notify);
  registerPlan(pi, session, notify);
  registerCatalog(pi, notify);
  registerRecords(pi, notify);
  registerWorktrees(pi, activeWorktrees);
  registerDelegation(pi, activeWorktrees);
  registerForge(pi, () => activePlan(session.state())?.route);
}
