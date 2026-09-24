import { expect, test } from "bun:test";
import { mentionsSkillEditingIntent } from "/Users/josh-desktop/.pi/agent/extensions/pstack-guards.ts";
const body = "Broken skill mid-task: fix it. Edit the skills. Create a skill.";
test("an expanded skill body is not the user's intent", () => {
  expect(mentionsSkillEditingIntent(`<skill name="poteto-mode" location="x">\n${body}\n</skill>\n\nadd a dueDate field`)).toBe(false);
});
test("typed intent still counts", () => {
  expect(mentionsSkillEditingIntent(`<skill name="poteto-mode" location="x">\n${body}\n</skill>\n\nplease edit the arena skill`)).toBe(true);
  expect(mentionsSkillEditingIntent(`<skill name="create-skill" location="x">\n${body}\n</skill>`)).toBe(true);
  expect(mentionsSkillEditingIntent("create the file ~/.pi/agent/skills/bro/notes.md with hi")).toBe(true);
  expect(mentionsSkillEditingIntent("the bro skill looks outdated, whatever, just tell me the time")).toBe(false);
});
