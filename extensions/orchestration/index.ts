import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerArena } from "./arena.ts";
import { registerSwarm } from "./swarm.ts";

export function registerOrchestration(pi: ExtensionAPI): void {
  registerSwarm(pi);
  registerArena(pi);
}
