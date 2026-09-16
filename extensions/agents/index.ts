/**
 * pstack agents module: the policy guard plus the policy-complete pstack_task tool.
 * The guard registers first so a child with PSTACK_CHILD_POLICY is already gated
 * before any tool the task tool might trigger runs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPolicyGuard } from "./policy-guard.ts";
import { registerTask } from "./task.ts";

export function registerAgents(pi: ExtensionAPI): void {
  registerPolicyGuard(pi);
  registerTask(pi);
}
