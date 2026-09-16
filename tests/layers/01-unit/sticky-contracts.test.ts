import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPotetoRuntime } from "../../../extensions/poteto-state/index.ts";
import { loadPlaybookBody } from "../../../extensions/sticky-playbook.ts";
import {
  POTETO_SKILL,
  loadPotetoStickyBody,
  stripFrontmatter,
} from "../../../extensions/sticky-poteto.ts";

const SKILL_HEADER = "## Poteto mode (sticky \u2014 re-injected each turn)";
// A pstack child process sets PSTACK_CHILD_ROLE, which disables sticky arming for
// the child. These tests exercise the parent path, so the ambient value must not leak in.
const savedChildRole = process.env.PSTACK_CHILD_ROLE;
Reflect.deleteProperty(process.env, "PSTACK_CHILD_ROLE");
test.after(() => {
  if (savedChildRole === undefined) Reflect.deleteProperty(process.env, "PSTACK_CHILD_ROLE");
  else process.env.PSTACK_CHILD_ROLE = savedChildRole;
});
const SKILL_TRAILER = "(End sticky skill body. Casual turns: stay concise. Opt out: /poteto-mode-off.)";
const PLAYBOOK_HEADER = "## Matched playbook (sticky routing \u2014 forced)";
const RESTORED_HEADER = "## Restored sticky playbook (steps reinjected)";
const PLAYBOOK_TRAILER = "(End matched playbook babysit.)";
const SKILL_TRUNCATION_MARKER =
  "[\u2026poteto-mode skill truncated for sticky inject; full file: skills/poteto-mode/SKILL.md]";

type PromptHandler = (event: { systemPrompt: string }, ctx: unknown) => { systemPrompt?: string } | undefined;
type InputHandler = (
  event: { source: string; text: string },
  ctx: unknown,
) => { action: string; text: string } | undefined;

interface CommandSpec {
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function fakeStickyPi(
  handlers: Map<string, unknown>,
  commands: Map<string, CommandSpec>,
  onMessage: (message: { text: string; opts?: unknown }) => void,
  onEntry: (entry: { entryType: string; payload: unknown }) => void,
) {
  return {
    on(name: string, fn: unknown) {
      handlers.set(name, fn);
    },
    appendEntry(entryType: string, payload: unknown) {
      onEntry({ entryType, payload });
    },
    registerCommand(name: string, spec: CommandSpec) {
      commands.set(name, spec);
    },
    sendUserMessage(text: string, opts?: unknown) {
      onMessage({ text, opts });
    },
  };
}

function fakeStickyUi(onStatus: (status: [string, string | undefined]) => void) {
  return {
    setStatus(id: string, value: string | undefined) {
      onStatus([id, value]);
    },
    notify(message: string, level: string) {
      onStatus(["notify", `${level}:${message}`]);
    },
  };
}

function fakeStickyEnv() {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, CommandSpec>();
  let messages: Array<{ text: string; opts?: unknown }> = [];
  let entries: Array<{ entryType: string; payload: unknown }> = [];
  let statuses: Array<[string, string | undefined]> = [];
  let armed: string[] = [];
  let released: string[] = [];
  const pi = fakeStickyPi(
    handlers,
    commands,
    (message) => {
      messages = [...messages, message];
    },
    (entry) => {
      entries = [...entries, entry];
    },
  );
  const ui = fakeStickyUi((status) => {
    statuses = [...statuses, status];
  });
  const runtime = createPotetoRuntime(pi as never, {
    armReadonly: (_ctx: unknown, reason: string) => {
      armed = [...armed, reason];
    },
    releaseReadonly: () => {
      released = [...released, "released"];
    },
  });
  return {
    ui,
    commands,
    runtime,
    prompt: () => handlers.get("before_agent_start") as PromptHandler | undefined,
    input: () => handlers.get("input") as InputHandler | undefined,
    messages: () => messages,
    entries: () => entries,
    statuses: () => statuses,
    armed: () => armed,
    released: () => released,
  };
}

function extractBetween(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  assert.equal(startIndex >= 0 && endIndex > startIndex, true, `missing section ${start}`);
  return text.slice(startIndex + start.length, endIndex).trim();
}

function assertCappedBodies(prompt: string, playbookHeader: string): void {
  const skillBody = extractBetween(prompt, SKILL_HEADER, SKILL_TRAILER);
  const rawSkillBody = stripFrontmatter(readFileSync(POTETO_SKILL, "utf8"));
  if (Buffer.byteLength(rawSkillBody, "utf8") <= 48_000) {
    assert.equal(skillBody, rawSkillBody, "an under-cap skill body is injected whole");
  } else {
    assert.equal(skillBody.includes(SKILL_TRUNCATION_MARKER), true, "an over-cap skill body is truncated");
    assert.equal(
      Buffer.byteLength(skillBody, "utf8") <= 48_000 + Buffer.byteLength(SKILL_TRUNCATION_MARKER, "utf8") + 2,
      true,
    );
  }
  assert.equal(Buffer.byteLength(loadPotetoStickyBody(), "utf8") <= 48_000 + 120, true);

  const playbookBody = loadPlaybookBody("babysit");
  assert.equal(prompt.includes(playbookHeader), true);
  assert.equal(prompt.includes(PLAYBOOK_TRAILER), true);
  assert.equal(prompt.includes(playbookBody), true, "the loaded, capped playbook body is injected");
  assert.equal(Buffer.byteLength(playbookBody, "utf8") <= 24_000 + 120, true);
}

async function runRoutedInput(childRole: string | undefined, text: string) {
  const env = fakeStickyEnv();
  const ctx = { ui: env.ui };
  await env.commands.get("poteto-mode")?.handler("", ctx);
  const savedChildRole = process.env.PSTACK_CHILD_ROLE;
  if (childRole === undefined) Reflect.deleteProperty(process.env, "PSTACK_CHILD_ROLE");
  else process.env.PSTACK_CHILD_ROLE = childRole;
  try {
    const result = env.input()?.({ source: "interactive", text }, ctx);
    return {
      result,
      matchedPlaybookId: env.runtime.getState().matchedPlaybookId,
      assignedThisTurn: env.runtime.getState().assignedThisTurn,
      armed: env.armed(),
    };
  } finally {
    if (savedChildRole === undefined) Reflect.deleteProperty(process.env, "PSTACK_CHILD_ROLE");
    else process.env.PSTACK_CHILD_ROLE = savedChildRole;
  }
}

test("sticky-01 /poteto-mode enables sticky mode and matches the playbook for the task", async () => {
  const env = fakeStickyEnv();
  const ctx = { ui: env.ui };
  await env.commands.get("poteto-mode")?.handler("babysit PR 12", ctx);

  const state = env.runtime.getState();
  assert.equal(state.enabled, true, "the command arms sticky mode");
  assert.equal(state.matchedPlaybookId, "babysit", "the task text is matched");
  assert.equal(state.matchedScore, 2);
  assert.equal(state.assignedThisTurn, false, "the command records the text for the next turn");
  assert.equal(state.lastUserText, "babysit PR 12");
  assert.deepEqual(env.statuses().at(-1), ["pstack", "poteto:babysit"]);
  assert.deepEqual(env.entries().at(-1), {
    entryType: "pstack-poteto-mode",
    payload: {
      enabled: true,
      matchedPlaybookId: "babysit",
      matchedScore: 2,
      updatedAt: env.entries().at(-1)?.payload.updatedAt,
    },
  });
  assert.deepEqual(env.messages(), [
    { text: "/skill:poteto-mode playbooks/babysit babysit PR 12", opts: { expandPromptTemplates: true, deliverAs: "followUp" } },
  ]);

  const plain = fakeStickyEnv();
  await plain.commands.get("poteto-mode")?.handler("   ", { ui: plain.ui });
  assert.equal(plain.runtime.getState().enabled, true);
  assert.equal(plain.runtime.getState().matchedPlaybookId, null, "no task means no playbook match");
  assert.deepEqual(plain.messages(), []);
  assert.deepEqual(plain.statuses(), [
    ["pstack", "poteto"],
    [
      "notify",
      "info:Poteto mode on (sticky skill + playbook auto-match; force skill invoke on match). Use /skill:poteto-mode <task> or /poteto-mode <task>.",
    ],
  ]);
});

test("sticky-06 caps the injected skill body at 48000 bytes and the playbook body at 24000 bytes", async () => {
  const restored = fakeStickyEnv();
  await restored.commands.get("poteto-mode")?.handler("babysit PR 12", { ui: restored.ui });
  const first = restored.prompt()?.({ systemPrompt: "BASE" }, {});
  const second = restored.prompt()?.({ systemPrompt: "BASE" }, {});
  assert.equal(first?.systemPrompt, second?.systemPrompt, "the section is injected on every turn");
  assert.equal((first?.systemPrompt ?? "").startsWith("BASE\n\n"), true);
  assertCappedBodies(first?.systemPrompt ?? "", RESTORED_HEADER);

  const routed = fakeStickyEnv();
  await routed.commands.get("poteto-mode")?.handler("", { ui: routed.ui });
  const transform = routed.input()?.({ source: "interactive", text: "babysit PR 12" }, { ui: routed.ui });
  assert.deepEqual(transform, {
    action: "transform",
    text: "/skill:poteto-mode playbooks/babysit babysit PR 12",
  });
  const assigned = routed.prompt()?.({ systemPrompt: "BASE" }, {});
  assertCappedBodies(assigned?.systemPrompt ?? "", PLAYBOOK_HEADER);

  const dir = mkdtempSync(join(tmpdir(), "pstack-sticky-cap-"));
  try {
    const bigPath = join(dir, "oversized.md");
    writeFileSync(bigPath, "x".repeat(30_000), "utf8");
    const capped = loadPlaybookBody(bigPath);
    const trailer = `\n\n[\u2026playbook truncated for sticky inject; full: ${bigPath}]`;
    assert.equal(Buffer.byteLength(capped, "utf8") <= 24_000 + Buffer.byteLength(trailer, "utf8"), true);
    assert.equal(capped.includes("[\u2026playbook truncated for sticky inject; full:"), true);
    assert.equal(capped.startsWith("x".repeat(1_000)), true);
    assert.equal(Buffer.byteLength(capped, "utf8") < 30_000, true, "the cap drops content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sticky-08 the input hook bypasses matching and force-invocation in a child session", async () => {
  const parent = await runRoutedInput(undefined, "babysit PR 12");
  assert.deepEqual(
    parent,
    {
      result: { action: "transform", text: "/skill:poteto-mode playbooks/babysit babysit PR 12" },
      matchedPlaybookId: "babysit",
      assignedThisTurn: true,
      armed: [],
    },
    "a parent session routes the same text",
  );

  const skillPrompt = await runRoutedInput("general", "/skill:poteto-mode babysit PR 12");
  assert.deepEqual(
    skillPrompt,
    { result: undefined, matchedPlaybookId: null, assignedThisTurn: false, armed: [] },
    "a child session must not match a playbook from the spawned prompt",
  );

  const plainPrompt = await runRoutedInput("general", "babysit PR 12");
  assert.deepEqual(
    plainPrompt,
    { result: undefined, matchedPlaybookId: null, assignedThisTurn: false, armed: [] },
    "a child session must not force-invoke poteto-mode",
  );

  const investigation = await runRoutedInput(
    "general",
    "/skill:poteto-mode playbooks/investigation why is the build slow",
  );
  assert.deepEqual(
    investigation,
    { result: undefined, matchedPlaybookId: null, assignedThisTurn: false, armed: [] },
    "a child session must not arm readonly",
  );
});
