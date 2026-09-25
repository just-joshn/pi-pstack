import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export const packageResources = {
  agentsDirectory: path.join(packageRoot, "agents"),
  guardExtension: path.join(packageRoot, "extensions", "pstack-guards.ts"),
  skillsDirectory: path.join(packageRoot, "skills"),
  potetoModeSkillDirectory: path.join(packageRoot, "skills", "poteto-mode"),
  potetoModeSkillFile: path.join(packageRoot, "skills", "poteto-mode", "SKILL.md"),
  potetoPlaybooksDirectory: path.join(packageRoot, "skills", "poteto-mode", "playbooks"),
} as const;
