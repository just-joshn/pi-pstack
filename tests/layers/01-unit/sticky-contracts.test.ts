import { afterAll, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPotetoRuntime } from "../../../extensions/poteto-state/index.ts";
import { loadPlaybookBody } from "../../../extensions/sticky-playbook.ts";
import {
  POTETO_SKILL,
  buildPotetoStickyPrompt,
  clearPotetoStickyCache,
  loadPotetoReminder,
  loadPotetoStickyBody,
  stripFrontmatter,
} from "../../../extensions/sticky-poteto.ts";

// The real skill file exists on disk and carries a reminder, and its body is under
// the 48000-byte cap, so three arms only run when node:fs reports otherwise. The
// module exports no seam to redirect the path, so the fs read is wrapped here and
// driven by these flags. Everything else still delegates to the real module.
let skillFileMissing = false;
let skillRawOverride: string | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const targetsPotetoSkill = (path: unknown): boolean =>
    String(path).endsWith("skills/poteto-mode/SKILL.md");
  return {
    ...actual,
    default: actual,
    existsSync: (path: string): boolean =>
      skillFileMissing && targetsPotetoSkill(path) ? false : actual.existsSync(path),
    readFileSync: (path: string, options?: unknown): unknown =>
      skillRawOverride !== undefined && targetsPotetoSkill(path)
        ? skillRawOverride
        : (actual.readFileSync as (file: string, opts?: unknown) => unknown)(path, options),
  };
});

// The real missing-file message the module returns; asserted as an exact value so a
// change to the fallback text fails the test instead of silently matching a prefix.
const MISSING_SKILL_BODY =
  "Poteto mode is active (pi-pstack). Skill file missing \u2014 apply /skill:poteto-mode when a playbook matches. Use pstack_spawn / pstack_swarm / pstack_arena.";

const SKILL_HEADER = "## Poteto mode (sticky \u2014 re-injected each turn)";
// A pstack child process sets PSTACK_CHILD_ROLE, which disables sticky arming for
// the child. These tests exercise the parent path, so the ambient value must not leak in.
const savedChildRole = process.env.PSTACK_CHILD_ROLE;
Reflect.deleteProperty(process.env, "PSTACK_CHILD_ROLE");
afterAll(() => {
  if (savedChildRole === undefined) Reflect.deleteProperty(process.env, "PSTACK_CHILD_ROLE");
  else process.env.PSTACK_CHILD_ROLE = savedChildRole;
});
const SKILL_TRAILER = "(End sticky skill body. Casual turns: stay concise. Opt out: /poteto-mode-off.)";
const PLAYBOOK_HEADER = "## Matched playbook (sticky routing \u2014 forced)";
const RESTORED_HEADER = "## Restored sticky playbook (steps reinjected)";
const PLAYBOOK_TRAILER = "(End matched playbook babysit.)";
const SKILL_TRUNCATION_MARKER =
  "[\u2026poteto-mode skill truncated for sticky inject; full file: skills/poteto-mode/SKILL.md]";
const MATCHED_PLAYBOOK_HEADER = "## Matched playbook (sticky routing \u2014 forced)";
const ROUTING_NOTE_HEADER = "## Sticky playbook routing";

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
  expect(startIndex >= 0 && endIndex > startIndex, `missing section ${start}`).toBe(true);
  return text.slice(startIndex + start.length, endIndex).trim();
}

function assertCappedBodies(prompt: string, playbookHeader: string): void {
  const skillBody = extractBetween(prompt, SKILL_HEADER, SKILL_TRAILER);
  const rawSkillBody = stripFrontmatter(readFileSync(POTETO_SKILL, "utf8"));
  if (Buffer.byteLength(rawSkillBody, "utf8") <= 48_000) {
    expect(skillBody, "an under-cap skill body is injected whole").toBe(rawSkillBody);
  } else {
    expect(skillBody.includes(SKILL_TRUNCATION_MARKER), "an over-cap skill body is truncated").toBe(true);
    expect(Buffer.byteLength(skillBody, "utf8") <= 48_000 + Buffer.byteLength(SKILL_TRUNCATION_MARKER, "utf8") + 2).toBe(true);
  }
  expect(Buffer.byteLength(loadPotetoStickyBody(), "utf8") <= 48_000 + 120).toBe(true);

  const playbookBody = loadPlaybookBody("babysit");
  expect(prompt.includes(playbookHeader)).toBe(true);
  expect(prompt.includes(PLAYBOOK_TRAILER)).toBe(true);
  expect(prompt.includes(playbookBody), "the loaded, capped playbook body is injected").toBe(true);
  expect(Buffer.byteLength(playbookBody, "utf8") <= 24_000 + 120).toBe(true);
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
  expect(state.enabled, "the command arms sticky mode").toBe(true);
  expect(state.matchedPlaybookId, "the task text is matched").toBe("babysit");
  expect(state.matchedScore).toBe(2);
  expect(state.assignedThisTurn, "the command records the text for the next turn").toBe(false);
  expect(state.lastUserText).toBe("babysit PR 12");
  expect(env.statuses().at(-1)).toEqual(["pstack", "poteto:babysit"]);
  const entry = env.entries().at(-1);
  expect(entry?.entryType).toBe("pstack-poteto-mode");
  expect(entry?.payload).toEqual({
    enabled: true,
    matchedPlaybookId: "babysit",
    matchedScore: 2,
    updatedAt: expect.any(Number),
  });
  expect(env.messages()).toEqual([
    { text: "/skill:poteto-mode playbooks/babysit babysit PR 12", opts: { expandPromptTemplates: true, deliverAs: "followUp" } },
  ]);

  const plain = fakeStickyEnv();
  await plain.commands.get("poteto-mode")?.handler("   ", { ui: plain.ui });
  expect(plain.runtime.getState().enabled).toBe(true);
  expect(plain.runtime.getState().matchedPlaybookId, "no task means no playbook match").toBe(null);
  expect(plain.messages()).toEqual([]);
  expect(plain.statuses()).toEqual([
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
  expect(first?.systemPrompt, "the section is injected on every turn").toBe(second?.systemPrompt);
  expect((first?.systemPrompt ?? "").startsWith("BASE\n\n")).toBe(true);
  assertCappedBodies(first?.systemPrompt ?? "", RESTORED_HEADER);

  const routed = fakeStickyEnv();
  await routed.commands.get("poteto-mode")?.handler("", { ui: routed.ui });
  const transform = routed.input()?.({ source: "interactive", text: "babysit PR 12" }, { ui: routed.ui });
  expect(transform).toEqual({
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
    expect(Buffer.byteLength(capped, "utf8") <= 24_000 + Buffer.byteLength(trailer, "utf8")).toBe(true);
    expect(capped.includes("[\u2026playbook truncated for sticky inject; full:")).toBe(true);
    expect(capped.startsWith("x".repeat(1_000))).toBe(true);
    expect(Buffer.byteLength(capped, "utf8") < 30_000, "the cap drops content").toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sticky-08 the input hook bypasses matching and force-invocation in a child session", async () => {
  const parent = await runRoutedInput(undefined, "babysit PR 12");
  expect(parent, "a parent session routes the same text").toEqual({
      result: { action: "transform", text: "/skill:poteto-mode playbooks/babysit babysit PR 12" },
      matchedPlaybookId: "babysit",
      assignedThisTurn: true,
      armed: [],
    });

  const skillPrompt = await runRoutedInput("general", "/skill:poteto-mode babysit PR 12");
  expect(skillPrompt, "a child session must not match a playbook from the spawned prompt").toEqual({ result: undefined, matchedPlaybookId: null, assignedThisTurn: false, armed: [] });

  const plainPrompt = await runRoutedInput("general", "babysit PR 12");
  expect(plainPrompt, "a child session must not force-invoke poteto-mode").toEqual({ result: undefined, matchedPlaybookId: null, assignedThisTurn: false, armed: [] });

  const investigation = await runRoutedInput(
    "general",
    "/skill:poteto-mode playbooks/investigation why is the build slow",
  );
  expect(investigation, "a child session must not arm readonly").toEqual({ result: undefined, matchedPlaybookId: null, assignedThisTurn: false, armed: [] });
});

test("sticky-09 falls back to the routing body and drops the reminder when the skill file is absent", () => {
  clearPotetoStickyCache();
  skillFileMissing = true;
  try {
    expect(loadPotetoReminder(), "a missing skill file yields no reminder").toBe(undefined);
    const body = loadPotetoStickyBody();
    expect(body, "a missing skill file yields the routing fallback").toBe(MISSING_SKILL_BODY);

    const prompt = buildPotetoStickyPrompt("BASE");
    expect(prompt.includes(MISSING_SKILL_BODY), "the fallback body is injected").toBe(true);
    expect(prompt.includes("Reminder:"), "no reminder line is injected").toBe(false);
    expect(prompt.includes(ROUTING_NOTE_HEADER), "the no-match routing tail is injected").toBe(true);
  } finally {
    skillFileMissing = false;
    clearPotetoStickyCache();
  }
});

test("sticky-10 truncates an oversized skill body for the sticky inject", () => {
  clearPotetoStickyCache();
  const raw = `---\nreminder: oversized reminder\n---\n${"x".repeat(50_000)}`;
  skillRawOverride = raw;
  try {
    const body = loadPotetoStickyBody();
    expect(body.includes(SKILL_TRUNCATION_MARKER), "an over-cap body is truncated").toBe(true);
    expect(
      Buffer.byteLength(body, "utf8") <= 48_000 + Buffer.byteLength(SKILL_TRUNCATION_MARKER, "utf8") + 2,
      "the truncated body stays within the cap plus the marker",
    ).toBe(true);
    expect(body.startsWith("x".repeat(1_000)), "the routing-critical head is kept").toBe(true);
    expect(body.length < raw.length, "the truncation drops content").toBe(true);
  } finally {
    skillRawOverride = undefined;
    clearPotetoStickyCache();
  }
});

test("sticky-11 honors an explicit null match and an explicit min score", () => {
  const nullMatch = buildPotetoStickyPrompt("BASE", { match: null });
  expect(nullMatch.includes(MATCHED_PLAYBOOK_HEADER), "a null match injects no playbook block").toBe(false);
  expect(nullMatch.includes(ROUTING_NOTE_HEADER), "a null match falls through to the routing note").toBe(true);

  const matched = buildPotetoStickyPrompt("BASE", { userText: "babysit PR 12" });
  expect(matched.includes(MATCHED_PLAYBOOK_HEADER), "user text is matched into a playbook block").toBe(true);
  expect(matched.includes("Matched **babysit** (score=2)"), "the default min score accepts a score-2 match").toBe(true);

  const raised = buildPotetoStickyPrompt("BASE", { userText: "babysit PR 12", minScore: 99 });
  expect(raised.includes(MATCHED_PLAYBOOK_HEADER), "a raised min score rejects the same match").toBe(false);
  expect(raised.includes(ROUTING_NOTE_HEADER), "the rejected match falls through to the routing note").toBe(true);
});
