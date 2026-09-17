/**
 * Skill reference paths.
 *
 * Pi tells the agent "References are relative to <SKILL.md directory>", and the
 * Agent Skills spec says to use paths from the skill root. Upstream nested
 * reference files point at their targets from their own directory instead, so
 * those strings are rewritten to resolve from the skill root.
 */
export const bindingsLinks = [
  {
    id: "skill-ref-why-sources",
    why: "Pi resolves skill references against the SKILL.md directory; upstream source links inside references/ are file-relative",
    files: ["skills/why/references/source-playbook.md"],
    find: "](./sources/",
    replace: "](references/sources/",
  },
  {
    id: "skill-ref-why-investigator-index",
    why: "Pi resolves skill references against the SKILL.md directory; the investigator template names the source index file-relative",
    files: ["skills/why/references/investigator-prompt.md"],
    find: "`source-playbook.md`",
    replace: "`references/source-playbook.md`",
  },
  {
    id: "skill-ref-why-investigator-playbook",
    why: "Pi resolves skill references against the SKILL.md directory; the investigator template names a category playbook file-relative",
    files: ["skills/why/references/investigator-prompt.md"],
    find: "`sources/<source>.md`",
    replace: "`references/sources/<source>.md`",
  },
  {
    id: "skill-ref-why-investigator-incident",
    why: "Pi resolves skill references against the SKILL.md directory; the investigator template names the incident playbook file-relative",
    files: ["skills/why/references/investigator-prompt.md"],
    find: "`sources/incident-postmortem.md`",
    replace: "`references/sources/incident-postmortem.md`",
  },
  {
    id: "skill-ref-architect-phase-a",
    why: "Pi resolves skill references against the SKILL.md directory; the rationale template links SKILL.md file-relative",
    files: ["skills/architect/references/rationale-template.md"],
    find: "](../SKILL.md#phase-a-ground-the-problem)",
    replace: "](SKILL.md#phase-a-ground-the-problem)",
  },
  {
    id: "skill-ref-architect-arena",
    why: "Pi resolves skill references against the SKILL.md directory; the rationale template links the arena skill file-relative",
    files: ["skills/architect/references/rationale-template.md"],
    find: "](../../arena/SKILL.md)",
    replace: "](../arena/SKILL.md)",
  },
  {
    id: "skill-ref-architect-runner-template",
    why: "Pi resolves skill references against the SKILL.md directory; the runner prompt links the rationale template file-relative",
    files: ["skills/architect/references/runner-prompt.md"],
    find: "](rationale-template.md)",
    replace: "](references/rationale-template.md)",
  },
  {
    id: "skill-ref-verification-example-note",
    why: "Pi resolves skill references against the SKILL.md directory; the feature-map example links a sibling note file-relative",
    files: ["skills/create-verification-skill/references/feature-map-example/README.md"],
    find: "](./create-note.md)",
    replace: "](references/feature-map-example/create-note.md)",
  },
  {
    id: "skill-ref-verification-example-search",
    why: "Pi resolves skill references against the SKILL.md directory; the feature-map example links a sibling flow file-relative",
    files: ["skills/create-verification-skill/references/feature-map-example/README.md"],
    find: "](./search.md)",
    replace: "](references/feature-map-example/search.md)",
  },
  {
    id: "skill-ref-benny-feature-map",
    why: "Pi resolves skill references against the SKILL.md directory; the control adapter links the feature-map example file-relative",
    files: ["automations/benny/skills/reproduce-and-fix-issues/references/control-adapter.md"],
    find: "](./feature-map.example.md)",
    replace: "](references/feature-map.example.md)",
  },
];
