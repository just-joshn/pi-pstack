import { expect, test } from "bun:test";
import { packageResources } from "./package-resources.ts";
import { namedSkillInstruction, stickyModeReminderText } from "./pstack-mode.ts";

test("sticky and named-skill messages use resolved package paths", () => {
  expect(stickyModeReminderText()).toContain(packageResources.potetoModeSkillFile);
  expect(stickyModeReminderText()).not.toContain("~/.pi/agent/skills");

  const instruction = namedSkillInstruction("investigation");
  expect(instruction).toContain(`${packageResources.potetoPlaybooksDirectory}/*.md`);
  expect(instruction).not.toContain("~/.pi/agent/skills");
});
