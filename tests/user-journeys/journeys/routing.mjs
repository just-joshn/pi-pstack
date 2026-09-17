import { expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const READONLY_TOOLS = ["read", "grep", "find", "ls"];
const STICKY_ENTRY = "pstack-poteto-mode";
const READONLY_ENTRY = "pstack-session-readonly";
const BUG_FIX_MESSAGE = "/skill:poteto-mode playbooks/bug-fix fix this bug";
const POTETO_OFF_NOTICE = ["info", "Poteto mode off."];
const READONLY_ON_NOTICE = ["info", "Session readonly on (command): write/edit/bash blocked."];
const READONLY_OFF_NOTICE = ["info", "Session readonly off."];
const BASH_BLOCK_REASON = "pstack session readonly: blocked bash. Use /pstack-readonly-off to re-enable writes.";
const READONLY_PROMPT = [
  "## pstack session readonly",
  "This session is read-only. Do not write, edit, or run bash. Use read/grep/find/ls (and read-safe pstack_* tools). " +
    "Spawn children with readonly:true or role investigator/comment-sicko. Deliver citations and recommendations only.",
].join("\n");
const DESLOP_MESSAGE =
  "Run pstack_deslop on the current diff against main (consider applySafe:true for safe comment deletes), " +
  "then apply /skill:unslop to any prose surfaces and fix remaining findings with edit.";
const BABYSIT_BODY =
  "Follow poteto-mode playbooks/babysit.md. Use pstack_babysit / pstack_loop (mode=dynamic) for wakes, " +
  "not Cursor /loop chrome.";
const SHIP_BODY =
  "Follow poteto-mode playbooks/shipping.md. Use pstack_ship (gh-only). Per-PR verify via local pstack_spawn + " +
  "worktree (background omit/default; drain pstack_jobs), not Cursor cloud VMs.";
const GATES_USAGE =
  "Usage: /pstack-gates <pr>. Also run /skill:unslop → /skill:no-comments → prove-it-works.";
const DEFAULT_ROLE_KEYS = [
  "feature, refactoring",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "judgment and prose",
  "hardest tasks",
  "how explorer",
  "how explainer",
  "why investigators",
  "why synthesizer",
  "reflect tooling",
  "reflect judgment, divergent, synthesizer",
  "arena runners",
  "arena cross-judge pool",
  "swarm workers",
  "architect runners",
  "interrogate reviewers",
];

function effectCounts(user) {
  return {
    messages: user.messages().length,
    notifications: user.notifications().length,
    entries: user.entries().length,
    statuses: user.statuses().length,
  };
}

function effectDelta(before, after) {
  return (
    after.messages - before.messages + (after.notifications - before.notifications) + (after.entries - before.entries)
  );
}

function modelsConfigPath() {
  return join(process.env.HOME ?? "", ".pi", "agent", "pstack-models.json");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertPotetoArmed(user, before, after) {
  const data = user.entry(STICKY_ENTRY)?.data;
  expect(data?.enabled).toBe(true);
  expect(data?.matchedPlaybookId).toBe("bug-fix");
  expect(data?.matchedScore).toBe(3);
  expect(user.status("pstack")).toBe("poteto:bug-fix");
  expect(user.message()).toBe(BUG_FIX_MESSAGE);
  expect(after.entries).toBe(before.entries + 1);
}

function assertPotetoOff(user, before, after) {
  const data = user.entry(STICKY_ENTRY)?.data;
  expect(data?.enabled).toBe(false);
  expect(data?.matchedPlaybookId).toBe(null);
  expect(user.status("pstack")).toBe(undefined);
  expect(user.notifications().at(-1)).toEqual(POTETO_OFF_NOTICE);
  expect(after.entries).toBe(before.entries + 1);
}

function assertToolCensus(user, before, after) {
  const notice = user.notifications().at(-1);
  expect(notice?.[0]).toBe("info");
  expect(String(notice?.[1]).startsWith("pi-pstack tools: pstack_spawn, "), `unexpected census: ${notice?.[1]}`).toBeTruthy();
  expect(user.entry(STICKY_ENTRY)?.data?.enabled).toBe(true);
  expect(user.status("pstack")).toBe("poteto");
  expect(after.messages).toBe(before.messages);
}

function assertReadonlyArmed(user, before, after) {
  const data = user.entry(READONLY_ENTRY)?.data;
  expect(data?.enabled).toBe(true);
  expect(data?.reason).toBe("command");
  expect(user.status("pstack-ro")).toBe("readonly");
  expect(user.notifications().at(-1)).toEqual(READONLY_ON_NOTICE);
  expect(user.activeTools()).toEqual(READONLY_TOOLS);
  expect(after.entries).toBe(before.entries + 1);
}

function assertReadonlyOff(user, before, after) {
  const data = user.entry(READONLY_ENTRY)?.data;
  expect(data?.enabled).toBe(false);
  expect(user.status("pstack-ro")).toBe(undefined);
  expect(user.notifications().at(-1)).toEqual(READONLY_OFF_NOTICE);
  expect(user.activeTools()).toEqual(BUILTIN_TOOLS);
  expect(after.entries).toBe(before.entries + 1);
}

function assertSetupPstack(user, before, after) {
  const path = modelsConfigPath();
  const notice = user.notifications().at(-1);
  const text = String(notice?.[1]);
  expect(notice?.[0]).toBe("info");
  expect(text.startsWith(`Wrote ${path}`), `unexpected setup-pstack notify: ${text}`).toBeTruthy();
  expect(text.endsWith("Bare Cursor marketing slugs are mapped or refused."), `unexpected setup-pstack notify: ${text}`).toBeTruthy();
  const written = readJson(path);
  expect(written.version).toBe(1);
  expect(written.budget).toBe("unlimited (max)");
  expect(Object.keys(written.roles).toSorted()).toEqual(DEFAULT_ROLE_KEYS.toSorted());
  expect(written.roles["arena runners"].length).toBe(4);
  expect(after.messages).toBe(before.messages);
}

function assertGatesUsage(user, before, after) {
  expect(user.notifications().at(-1)).toEqual(["error", GATES_USAGE]);
  expect(after.messages).toBe(before.messages);
}

function assertEmptyLoopStatus(user, before, after) {
  expect(user.notifications().at(-1)).toEqual(["info", "(no active loops)"]);
  expect(after.messages).toBe(before.messages);
}

function assertDeslopQueued(user, before, after) {
  expect(user.message()).toBe(DESLOP_MESSAGE);
  expect(user.notifications().at(-1)).toEqual(["info", "Queued deslop twin"]);
  expect(after.messages).toBe(before.messages + 1);
}

function assertSingleMessage(user, before, after, expected) {
  expect(after.messages, `expected exactly one message, saw ${after.messages - before.messages}`).toBe(before.messages + 1);
  expect(after.notifications, "unexpected notification").toBe(before.notifications);
  expect(user.message()).toBe(expected);
  expect(user.messages().at(-1)?.options?.expandPromptTemplates).toBe(true);
}

function assertBabysitBody(user, before, after) {
  assertSingleMessage(user, before, after, BABYSIT_BODY);
}

function assertShipBody(user, before, after) {
  assertSingleMessage(user, before, after, SHIP_BODY);
}

function assertBennyPreflight(user, suffix) {
  const message = user.message() ?? "";
  expect(message.startsWith("Read and follow "), `unexpected benny message: ${message}`).toBeTruthy();
  expect(message.endsWith(suffix), `unexpected benny message: ${message}`).toBeTruthy();
  expect(user.messages().at(-1)?.options?.expandPromptTemplates).toBe(false);
}

function assertSetupBenny(user, before, after) {
  assertBennyPreflight(
    user,
    "/automations/benny/skills/setup-benny/SKILL.md. Retarget paths to .pi/automations/benny and .pi/benny. " +
      "Do not use Cursor Automations host APIs.",
  );
  expect(after.messages).toBe(before.messages + 1);
}

function assertBennyTriage(user, before, after) {
  assertBennyPreflight(
    user,
    "/automations/benny/skills/triage-issue-reports/SKILL.md. Await the next Slack/tracker issue payload " +
      "from pstack_benny_wake or chat.",
  );
  expect(after.messages).toBe(before.messages + 1);
}

function assertBennyRepro(user, before, after) {
  assertBennyPreflight(
    user,
    "/automations/benny/skills/reproduce-and-fix-issues/SKILL.md. Use pstack_control_cli / pstack_control_ui " +
      "for the control adapter. ",
  );
  expect(after.messages).toBe(before.messages + 1);
}

function assertSkillDispatch(user, name, before, after) {
  expect(after.messages, `/${name} sent ${after.messages - before.messages} messages`).toBe(before.messages + 1);
  expect(after.notifications, `/${name} notified`).toBe(before.notifications);
  expect(after.entries, `/${name} appended a session entry`).toBe(before.entries);
  expect(user.message()).toBe(`/skill:${name}`);
  expect(user.messages().at(-1)?.options?.expandPromptTemplates, `/${name} did not expand the template`).toBe(true);
}

const SAFE_ARGS = new Map([
  ["poteto-mode", "fix this bug"],
  ["pstack-loop", "status"],
  ["setup-pstack", ""],
  ["pstack-readonly", ""],
  ["pstack-readonly-off", ""],
  ["deslop", ""],
  ["setup-benny", ""],
  ["benny-triage", ""],
  ["benny-repro", ""],
]);

const RICH_COMMAND_CHECKS = new Map([
  ["poteto-mode", assertPotetoArmed],
  ["poteto-mode-off", assertPotetoOff],
  ["pstack", assertToolCensus],
  ["pstack-readonly", assertReadonlyArmed],
  ["pstack-readonly-off", assertReadonlyOff],
  ["setup-pstack", assertSetupPstack],
  ["pstack-gates", assertGatesUsage],
  ["pstack-loop", assertEmptyLoopStatus],
  ["deslop", assertDeslopQueued],
  ["babysit", assertBabysitBody],
  ["ship", assertShipBody],
  ["setup-benny", assertSetupBenny],
  ["benny-triage", assertBennyTriage],
  ["benny-repro", assertBennyRepro],
]);

async function invokeCommand(user, name) {
  const before = effectCounts(user);
  await user.command(name, SAFE_ARGS.get(name) ?? "");
  const after = effectCounts(user);
  expect(effectDelta(before, after) > 0, `/${name} produced no observable effect`).toBeTruthy();
  const check = RICH_COMMAND_CHECKS.get(name);
  if (check) check(user, before, after);
  else assertSkillDispatch(user, name, before, after);
}

async function invokeEveryCommand(user) {
  const names = user.commands();
  const skillNames = names.filter((name) => !RICH_COMMAND_CHECKS.has(name));
  expect(skillNames.length, `expected 45 skill commands, saw ${skillNames.length}`).toBe(45);
  for (const name of names) await invokeCommand(user, name);
}

function writeProjectModels(user) {
  const config = { version: 1, budget: "large", roles: { "feature, refactoring": "openai/gpt-5" } };
  user.write(".pi/pstack-models.json", `${JSON.stringify(config, null, 2)}\n`);
}

function assertHomeModelDefaults() {
  const written = readJson(modelsConfigPath());
  expect(written.version).toBe(1);
  expect(written.budget).toBe("unlimited (max)");
  expect(Object.keys(written.roles).toSorted()).toEqual(DEFAULT_ROLE_KEYS.toSorted());
  expect(written.roles["arena runners"].length).toBe(4);
}

async function setupModels(user) {
  await user.command("setup-pstack", "");
  const notice = user.notifications().at(-1);
  const text = String(notice?.[1]);
  expect(notice?.[0]).toBe("info");
  expect(text.startsWith(`Wrote ${modelsConfigPath()}`), `unexpected setup-pstack notify: ${text}`).toBeTruthy();
  expect(text.endsWith("Bare Cursor marketing slugs are mapped or refused."), `unexpected setup-pstack notify: ${text}`).toBeTruthy();
  assertHomeModelDefaults();
}

async function assertProjectConfigWins(user) {
  const prompt = await user.emitBeforeAgentStart("configure models", "BASE");
  expect(prompt.includes("## pstack model roles (validated always-applied twin)"), "model roles block missing").toBeTruthy();
  expect(prompt.includes("- feature, refactoring: openai/gpt-5"), `project role missing from the block:\n${prompt}`).toBeTruthy();
  expect(!prompt.includes("- bug-fix:"), "home role table leaked into the block; the project config should win").toBeTruthy();
  assertHomeModelDefaults();
}

async function assertConfiguredRoleDrivesSpawn(user) {
  const result = await user.tool("pstack_spawn", {
    task: "Investigate X and report PASS/ISSUES/BLOCKED",
    role: "general",
    background: false,
  });
  const text = result.content?.[0]?.text ?? "";
  expect(text.includes("stub-child model=openai/gpt-5"), `spawn did not use the configured role model:\n${text}`).toBeTruthy();
}

async function runConfigureModels(user) {
  await setupModels(user);
  writeProjectModels(user);
  await assertProjectConfigWins(user);
  await assertConfiguredRoleDrivesSpawn(user);
}

async function armStickyFromCommand(user) {
  await user.command("poteto-mode", "fix this bug");
  const data = user.entry(STICKY_ENTRY)?.data;
  expect(data?.enabled).toBe(true);
  expect(data?.matchedPlaybookId).toBe("bug-fix");
  expect(data?.matchedScore).toBe(3);
  expect(typeof data?.updatedAt).toBe("number");
  expect(user.status("pstack")).toBe("poteto:bug-fix");
  expect(user.message()).toBe(BUG_FIX_MESSAGE);
}

async function assertExtensionInputIgnored(user) {
  const before = effectCounts(user);
  const turn = await user.emitInput(BUG_FIX_MESSAGE, "extension");
  expect(turn).toEqual({ text: BUG_FIX_MESSAGE, handled: false });
  expect(effectDelta(before, effectCounts(user)), "extension input re-entered sticky routing").toBe(0);
}

async function assertForcedPlaybookInjection(user) {
  const turn = await user.emitInput("bug fix: fix this bug", "interactive");
  expect(turn?.text).toBe("/skill:poteto-mode playbooks/bug-fix bug fix: fix this bug");
  expect(user.entry(STICKY_ENTRY)?.data?.matchedScore).toBe(5);
  const prompt = await user.emitBeforeAgentStart("bug fix: fix this bug", "BASE");
  expect(prompt.includes("## Matched playbook (sticky routing — forced)"), "forced playbook header missing").toBeTruthy();
  expect(prompt.includes("Matched **bug-fix** (score=5) → `playbooks/bug-fix.md`."), "matched playbook line missing").toBeTruthy();
  expect(prompt.includes("### Bug fix"), "playbook body missing").toBeTruthy();
  expect(prompt.includes("(End matched playbook bug-fix.)"), "playbook terminator missing").toBeTruthy();
}

async function assertAliasIdentical(user) {
  await user.command("pstack", "fix this bug");
  expect(user.message()).toBe(BUG_FIX_MESSAGE);
}

async function assertUnmatchedFallback(user) {
  await user.command("poteto-mode-off", "");
  await user.command("poteto-mode", "polish the charts");
  expect(user.message()).toBe("/skill:poteto-mode polish the charts");
  const data = user.entry(STICKY_ENTRY)?.data;
  expect(data?.enabled).toBe(true);
  expect(data?.matchedPlaybookId).toBe(undefined);
  expect(user.status("pstack")).toBe("poteto");
}

async function assertOffIsIdempotent(user) {
  await user.command("poteto-mode-off", "");
  expect(user.entry(STICKY_ENTRY)?.data?.enabled).toBe(false);
  expect(user.status("pstack")).toBe(undefined);
  expect(user.notifications().at(-1)).toEqual(POTETO_OFF_NOTICE);
  const before = effectCounts(user);
  await user.command("poteto-mode-off", "");
  const after = effectCounts(user);
  expect(after.entries, "second off appended an entry").toBe(before.entries);
  expect(after.statuses, "second off wrote a status").toBe(before.statuses);
  expect(user.notifications().at(-1)).toEqual(POTETO_OFF_NOTICE);
}

async function runStickyRouting(user) {
  await armStickyFromCommand(user);
  await assertExtensionInputIgnored(user);
  await assertForcedPlaybookInjection(user);
  await assertAliasIdentical(user);
  await assertUnmatchedFallback(user);
  await assertOffIsIdempotent(user);
}

async function armReadonly(user) {
  await user.command("pstack-readonly", "");
  const data = user.entry(READONLY_ENTRY)?.data;
  expect(data?.enabled).toBe(true);
  expect(data?.reason).toBe("command");
  expect(typeof data?.updatedAt).toBe("number");
  expect(user.status("pstack-ro")).toBe("readonly");
  expect(user.notifications().at(-1)).toEqual(READONLY_ON_NOTICE);
  expect(user.activeTools()).toEqual(READONLY_TOOLS);
}

async function assertReadonlyBlocksWrites(user) {
  const bashDecisions = await user.emitToolCall("bash", { command: "ls" });
  const blocked = bashDecisions.find((decision) => decision?.block === true);
  expect(blocked?.reason).toBe(BASH_BLOCK_REASON);
  const spawnCall = { task: "Investigate X and report PASS/ISSUES/BLOCKED", role: "general" };
  const spawnDecisions = await user.emitToolCall("pstack_spawn", spawnCall);
  expect(spawnDecisions.every((decision) => decision?.block !== true), "pstack_spawn was blocked").toBeTruthy();
  expect(spawnCall.readonly, "pstack_spawn input did not gain readonly:true").toBe(true);
}

async function assertReadonlyPrompt(user) {
  const prompt = await user.emitBeforeAgentStart("read the code", "BASE");
  expect(prompt.includes("## pstack session readonly"), "readonly prompt header missing").toBeTruthy();
  expect(prompt.includes(READONLY_PROMPT), "readonly prompt body missing").toBeTruthy();
}

async function leaveReadonly(user) {
  await user.command("pstack-readonly-off", "");
  const data = user.entry(READONLY_ENTRY)?.data;
  expect(data?.enabled).toBe(false);
  expect(user.status("pstack-ro")).toBe(undefined);
  expect(user.notifications().at(-1)).toEqual(READONLY_OFF_NOTICE);
  expect(user.activeTools()).toEqual(BUILTIN_TOOLS);
}

async function assertSessionRestore(user) {
  await user.command("pstack-readonly", "");
  const before = effectCounts(user);
  await user.emitSessionStart();
  const after = effectCounts(user);
  expect(after.entries, "session_start appended an entry").toBe(before.entries);
  expect(after.statuses, "session_start did not re-apply the readonly status").toBe(before.statuses + 1);
  expect(user.statuses().at(-1)).toEqual(["pstack-ro", "readonly"]);
  expect(user.activeTools()).toEqual(READONLY_TOOLS);
}

async function runReadonlySession(user) {
  await armReadonly(user);
  await assertReadonlyBlocksWrites(user);
  await assertReadonlyPrompt(user);
  await leaveReadonly(user);
  await assertSessionRestore(user);
}

export const JOURNEYS = [
  {
    id: "invoke-every-command",
    title: "a user invokes every registered command and sees each one dispatch",
    critical: true,
    surfaces: ["commands"],
    run: invokeEveryCommand,
  },
  {
    id: "configure-models",
    title: "a user configures per-role models and sees them applied",
    critical: true,
    surfaces: ["models"],
    run: runConfigureModels,
  },
  {
    id: "sticky-task-routing",
    title: "a user routes a task to a poteto playbook and turns sticky mode off",
    critical: true,
    surfaces: ["sticky"],
    run: runStickyRouting,
  },
  {
    id: "readonly-session",
    title: "a user enters read-only mode, gets blocked, and leaves it",
    critical: true,
    surfaces: ["readonly"],
    run: runReadonlySession,
  },
];
