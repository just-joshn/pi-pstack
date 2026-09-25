import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { packageResources } from "./package-resources.ts";
import { mentionsSkillEditingIntent, skillWriteBlock } from "./pstack-guards.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pstack-guards-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("guards configured-agent and package skills but not unrelated workspace skills", () => {
  const root = tempRoot();
  const agentDir = path.join(root, "custom-agent-dir");
  const cwd = path.join(root, "workspace");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const agentSkill = path.join(agentDir, "skills", "local-skill", "SKILL.md");
    const packageSkill = path.join(packageResources.skillsDirectory, "poteto-mode", "SKILL.md");
    const expected = {
      block: true,
      reason: "Installed skills change only when the user asks. If a skill looks broken, check that its own text references the missing thing; if it does not, the claim is false.",
    };

    expect(skillWriteBlock(agentSkill, cwd, "")).toEqual(expected);
    expect(skillWriteBlock(packageSkill, cwd, "")).toEqual(expected);
    expect(skillWriteBlock(path.join(cwd, "skills", "local-skill", "SKILL.md"), cwd, "")).toBeUndefined();
    expect(mentionsSkillEditingIntent(`Please update ${agentSkill}`)).toBe(true);
    expect(mentionsSkillEditingIntent(`Please update ${packageSkill}`)).toBe(true);
    expect(mentionsSkillEditingIntent(`Please update ${path.join(cwd, "docs", "README.md")}`)).toBe(false);
    expect(skillWriteBlock(agentSkill, cwd, `Please update ${agentSkill}`)).toBeUndefined();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
