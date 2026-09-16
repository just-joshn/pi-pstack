import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerSkillCommands } from "../../../extensions/commands/skill-commands.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function skill(name: string): string {
  return readFileSync(resolve(ROOT, "skills", name, "SKILL.md"), "utf8");
}

function file(relpath: string): string {
  return readFileSync(resolve(ROOT, relpath), "utf8");
}

function missingSteps(text: string, needles: string[]): string[] {
  return needles.filter((needle) => !text.includes(needle));
}

function assertSteps(label: string, text: string, needles: string[]): void {
  assert.deepEqual(missingSteps(text, needles), [], `${label} must keep every mandated step`);
}

const WHY_CATEGORY_HEADINGS = [
  "**Source control investigator**.",
  "**Issue / ticket tracker investigator**",
  "**Long-form documents investigator**",
  "**Real-time team chat investigator**",
  "**Infrastructure observability investigator**",
  "**Error / exception tracking investigator**",
  "**Product analytics warehouse investigator**",
];

const PLAYBOOK_IDS = [
  "investigation",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "runtime-forensics",
  "trace-forensics",
  "feature",
  "refactoring",
  "prototype",
  "visual-parity",
  "authoring-a-skill",
  "eval",
  "babysit",
  "shipping",
  "autonomous-run",
  "orchestrate",
  "autopilot-full",
  "autopilot-stack",
  "session-pickup",
  "pause-safely",
  "multi-phase-plan",
  "worktree-cleanup",
  "opening-a-pr",
];

const WORKFLOW_COMMAND_NAMES = [
  "how",
  "why",
  "arena",
  "swarm",
  "interrogate",
  "reflect",
  "recall",
  "automate-me",
];

test("how skill keeps the simple and complex branches and the configured roles", () => {
  const text = skill("how");
  assertSteps("how", text, [
    "**Simple** (a single module, a small utility, a narrow question",
    "no explorers. One explainer explores and explains in a single pass.",
    "**Complex** (a subsystem spanning multiple files or services, a cross-cutting feature, a full architectural overview)",
    "spawn parallel explorers first, then hand off to the explainer.",
    "Decompose the question into 2 to 4 exploration angles",
    "your configured how-explorer model",
    "your configured how-explainer model",
  ]);
});

test("why skill keeps all seven evidence categories and the null-finding rule", () => {
  const text = skill("why");
  assert.equal(WHY_CATEGORY_HEADINGS.length, 7, "the roster stays at seven evidence categories");
  assertSteps("why", text, WHY_CATEGORY_HEADINGS);
  assertSteps("why", text, [
    "Aim for a complete **coverage map**, not a minimal one.",
    "Document the null, don't skip the search.",
  ]);
});

test("arena skill keeps the six phases, the derived rubric, and the independent cross-judge", () => {
  const text = skill("arena");
  assertSteps("arena", text, [
    "## Phase A: Frame",
    "## Phase B: Fan out",
    "## Phase C: Cross-judge",
    "## Phase D: Pick a base",
    "## Phase E: Graft",
    "## Phase F: Verify",
    "Derive the rubric. State what success looks like for *this* task",
    "Spawn one readonly judge subagent on that model.",
    "Prefer a different model family from the parent's.",
  ]);
});

test("swarm skill keeps the slice, race, and mixed modes plus the report contract", () => {
  const text = skill("swarm");
  assertSteps("swarm", text, [
    "Partition into slices, race N workers on identical briefs, or mix both.",
    "For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.",
    "Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.",
    "For a race, apply the selection rule declared up front.",
  ]);
});

test("interrogate skill keeps one reviewer per panel entry, the synthesis steps, and the lead labels", () => {
  const text = skill("interrogate");
  assertSteps("interrogate", text, [
    "Use the `interrogate reviewers` list from `~/.pi/agent/pstack-models.json` when present, one reviewer per entry",
    "**Identify consensus**. Findings raised by 2+ models independently are highest signal.",
    "**Identify lone-model findings**. Still worth reading, but weight accordingly.",
    "**Note disagreements**. If one model flags something and another explicitly says the opposite",
    "- **Act on**. Real issues affecting correctness, security, or maintainability given the actual goals.",
    "- **Consider**. Legitimate points, but you're not sure they outweigh the cost of addressing them right now.",
    "- **Noted**. Technically valid but not actionable.",
    "- **Dismissed**. Wrong, nitpicky, or missing context.",
  ]);
});

test("reflect skill keeps the approval gate and the structural-enforcement check", () => {
  const text = skill("reflect");
  assertSteps("reflect", text, [
    "### 4. Structural enforcement check",
    "For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog.",
    "Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval.",
    "Do not auto-apply.",
  ]);
});

test("recall skill keeps the capsule output contract and the default recent window", () => {
  const text = skill("recall");
  assertSteps("recall", text, [
    "## Output contract",
    "- **Capsule.** At most 5 bullets.",
    "- **Threads.** One line each, prefixed with exactly one status tag",
    "- **Problems.** At most 5, the recurring ones.",
    "- **Next move.** The single most useful next action, concrete.",
    "default the last 7 days",
  ]);
});

test("automate-me skill keeps the placement paths and the two-step corroboration", () => {
  const text = skill("automate-me");
  assertSteps("automate-me", text, [
    "Look recursively for `.pi/skills/**/*-mode/SKILL.md` and `~/.pi/agent/skills/*-mode/SKILL.md` matching the user's handle.",
    "`.pi/skills/<handle>/<handle>-mode/SKILL.md`",
    "`~/.pi/agent/skills/<handle>-mode/` if the user prefers a personal skill",
    "### 1. Mine their history",
    "Cross-check across slices before elevating a signal. Patterns seen in 2+ slices are high-confidence.",
    "### 2. Ask the user directly",
  ]);
});

test("poteto-mode skill keeps the 23-playbook table and the todos contract", () => {
  const text = skill("poteto-mode");
  assert.equal(PLAYBOOK_IDS.length, 23, "the playbook table stays at 23 entries");
  const section = text.slice(text.indexOf("## Playbooks"));
  const ids = [...section.matchAll(/playbooks\/([a-z0-9-]+)\.md/g)].map((match) => match[1]);
  assert.deepEqual(ids, PLAYBOOK_IDS, "the playbook table lists every playbook once, in order");
  assertSteps("poteto-mode", text, [
    "Open a todolist whose first items are the matched playbook's steps, copied in verbatim, before any task-specific todos.",
    "A step you choose not to do stays in the list with a one-line `skip: <reason>`.",
  ]);
});

type SkillCommandPi = Parameters<typeof registerSkillCommands>[0];

function recordingCommands(): { pi: SkillCommandPi; names: () => string[] } {
  let names: string[] = [];
  const fake = {
    registerCommand(name: string) {
      names = [...names, name];
    },
    sendUserMessage() {},
  };
  return { pi: fake as unknown as SkillCommandPi, names: () => names };
}

test("slash command shims register every workflow skill name", () => {
  const { pi, names } = recordingCommands();
  registerSkillCommands(pi);
  const registered = names();
  const absent = WORKFLOW_COMMAND_NAMES.filter((name) => !registered.includes(name));
  assert.deepEqual(absent, [], "every workflow skill keeps its /name shim");
});

test("the extension entry registers the poteto runtime before the readonly runtime", () => {
  const text = file("extensions/index.ts");
  const potetoAt = text.indexOf("createPotetoRuntime(pi,");
  const readonlyAt = text.indexOf("createReadonlyRuntime(pi)");
  assert.equal(potetoAt >= 0, true, "the poteto runtime is registered");
  assert.equal(readonlyAt >= 0, true, "the readonly runtime is registered");
  assert.equal(potetoAt < readonlyAt, true, "the poteto runtime registers before the readonly runtime");
});
