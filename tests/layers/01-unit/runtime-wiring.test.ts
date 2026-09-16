import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEffects } from "../../../extensions/effects.ts";
import {
  buildPlaybookInjectBlock,
  buildPlaybookInjectFromId,
  listPlaybookIds,
  loadPlaybookBody,
  matchPlaybook,
  playbookMatchFromId,
} from "../../../extensions/sticky-playbook.ts";
import {
  buildPotetoStickyPrompt,
  matchStickyPlaybook,
  stripFrontmatter,
} from "../../../extensions/sticky-poteto.ts";
import { createPotetoRuntime } from "../../../extensions/poteto-state/index.ts";
import { createReadonlyRuntime } from "../../../extensions/readonly-state/index.ts";

const savedChildRole = process.env.PSTACK_CHILD_ROLE;
Reflect.deleteProperty(process.env, "PSTACK_CHILD_ROLE");
test.after(() => {
  if (savedChildRole === undefined) Reflect.deleteProperty(process.env, "PSTACK_CHILD_ROLE");
  else process.env.PSTACK_CHILD_ROLE = savedChildRole;
});

function liveList<T>() {
  let items: T[] = [];
  return {
    add: (item: T) => {
      items = [...items, item];
    },
    all: () => items,
  };
}

function fakeEnvironment(options: { allTools?: string[]; activeTools?: string[] } = {}) {
  const handlers = new Map<string, any[]>();
  const entries = liveList<any>();
  const statuses = liveList<any>();
  const commands = new Map<string, any>();
  const messages = liveList<any>();
  const activeTools = liveList<string[]>();
  const pi: any = {
    on: (event: string, handler: any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry: (entryType: string, payload: unknown) => entries.add({ entryType, payload }),
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
    sendUserMessage: (text: string, opts: any) => messages.add({ text, opts }),
    getAllTools: () => (options.allTools ?? ["read", "write", "bash"]).map((name: string) => ({ name })),
    getActiveTools: () => options.activeTools ?? ["read", "write", "bash"],
    setActiveTools: (tools: string[]) => activeTools.add(tools),
  };
  const ui = {
    setStatus: (id: string, value: string | undefined) => statuses.add([id, value]),
    notify: (message: string, level: string) => statuses.add(["notify", `${level}:${message}`]),
  };
  const handler = (event: string, index = 0) => handlers.get(event)?.[index];
  return {
    pi,
    ui,
    handlers,
    commands,
    get entries() {
      return entries.all();
    },
    get statuses() {
      return statuses.all();
    },
    get messages() {
      return messages.all();
    },
    get activeTools() {
      return activeTools.all();
    },
    handler,
  };
}

test("applyEffects applies every effect in order against pi and ui", () => {
  const env = fakeEnvironment();
  applyEffects(env.pi, { ui: env.ui }, [
    { type: "appendEntry", entryType: "x", payload: { a: 1 } },
    { type: "setStatus", statusId: "s", value: "v" },
    { type: "notify", message: "hello", level: "info" },
    { type: "setActiveTools", tools: ["read"] },
  ]);
  assert.deepEqual(env.entries, [{ entryType: "x", payload: { a: 1 } }]);
  assert.deepEqual(env.statuses, [["s", "v"], ["notify", "info:hello"]]);
  assert.deepEqual(env.activeTools, [["read"]]);
});

test("applyEffects tolerates a missing ui notify", () => {
  const env = fakeEnvironment();
  const uiWithoutNotify = { setStatus: env.ui.setStatus };
  applyEffects(env.pi, { ui: uiWithoutNotify as any }, [{ type: "notify", message: "ignored", level: "info" }]);
  assert.deepEqual(env.statuses, []);
});

test("applyEffects swallows a guarded tool restore but propagates an unguarded one", () => {
  const env = fakeEnvironment();
  const throwingPi = {
    ...env.pi,
    setActiveTools: () => {
      throw new Error("session tearing down");
    },
  };
  applyEffects(throwingPi, { ui: env.ui }, [
    { type: "setActiveTools", tools: ["read"], guarded: true },
    { type: "setStatus", statusId: "s", value: "v" },
  ]);
  assert.deepEqual(env.statuses, [["s", "v"]]);
  assert.throws(
    () => applyEffects(throwingPi, { ui: env.ui }, [{ type: "setActiveTools", tools: ["read"] }]),
    /session tearing down/,
  );
});

test("matchPlaybook returns undefined for empty and unmatched text", () => {
  assert.equal(matchPlaybook(""), undefined);
  assert.equal(matchPlaybook("   "), undefined);
  assert.equal(matchPlaybook("what time is it"), undefined);
});

test("matchPlaybook matches by cue and by explicit playbook path", () => {
  assert.equal(matchPlaybook("babysit this PR")?.id, "babysit");
  assert.equal(matchPlaybook("check on PR #12")?.id, "babysit");
  assert.equal(matchPlaybook("follow playbooks/bug-fix now")?.id, "bug-fix");
  assert.equal(matchPlaybook("bugbot"), undefined, "a bare bugbot mention is not a PR-status request");
  assert.equal(matchPlaybook("bugbot commented on the PR")?.id, "babysit");
});

test("playbook lookup helpers report known and unknown ids", () => {
  assert.deepEqual(playbookMatchFromId("babysit"), {
    id: "babysit",
    file: "babysit.md",
    score: 0,
    priority: 100,
  });
  assert.equal(playbookMatchFromId("no-such-playbook"), undefined);
  const ids = listPlaybookIds();
  assert.equal(ids.includes("babysit"), true);
  assert.equal(ids.includes("no-such-playbook"), false);
});

test("loadPlaybookBody loads the stripped body and reports a missing file", () => {
  const body = loadPlaybookBody("babysit");
  assert.equal(body.startsWith("---"), false);
  assert.equal(body.length > 100, true);
  assert.match(loadPlaybookBody("no-such-playbook"), /playbook missing/);
});

test("buildPlaybookInjectFromId marks restored and matched blocks", () => {
  const restored = buildPlaybookInjectFromId("babysit", { restored: true });
  assert.equal(restored?.includes("## Restored sticky playbook (steps reinjected)"), true);
  assert.equal(restored?.includes("Open a todolist"), true);
  assert.equal(buildPlaybookInjectFromId("no-such-playbook"), undefined);
  const block = buildPlaybookInjectBlock(playbookMatchFromId("babysit")!);
  assert.equal(block.includes("## Matched playbook (sticky routing — forced)"), true);
});

test("stripFrontmatter removes the block and leaves plain input trimmed", () => {
  assert.equal(stripFrontmatter("---\nname: x\n---\nbody\n"), "body");
  assert.equal(stripFrontmatter("plain text\n"), "plain text");
  assert.equal(stripFrontmatter("---\nunclosed\n"), "---\nunclosed");
});

test("buildPotetoStickyPrompt injects the skill body and the routing tail", () => {
  const plain = buildPotetoStickyPrompt("BASE");
  assert.equal(plain.includes("BASE"), true);
  assert.equal(plain.includes("## Poteto mode (sticky — re-injected each turn)"), true);
  assert.equal(plain.includes("## Sticky playbook routing"), true);
  const matched = buildPotetoStickyPrompt("BASE", {
    match: { id: "babysit", file: "babysit.md", path: "/p/babysit.md", score: 5, priority: 100 },
  });
  assert.equal(matched.includes("## Matched playbook (sticky routing — forced)"), true);
  const restored = buildPotetoStickyPrompt("BASE", { restoredPlaybookId: "babysit" });
  assert.equal(restored.includes("## Restored sticky playbook (steps reinjected)"), true);
});

test("matchStickyPlaybook delegates to the matcher", () => {
  assert.equal(matchStickyPlaybook("babysit PR 9")?.id, "babysit");
  assert.equal(matchStickyPlaybook("unrelated"), undefined);
});

test("poteto runtime restores a persisted playbook on session_start", () => {
  const env = fakeEnvironment();
  const runtime = createPotetoRuntime(env.pi, { armReadonly: () => {} });
  const branch = [
    { type: "custom", customType: "pstack-poteto-mode", data: { enabled: true, matchedPlaybookId: "why" } },
  ];
  env.handler("session_start")({}, { sessionManager: { getBranch: () => branch }, ui: env.ui });
  assert.deepEqual(runtime.getState(), {
    enabled: true,
    matchedPlaybookId: "why",
    matchedScore: 0,
    assignedThisTurn: false,
    lastUserText: "",
  });
  assert.deepEqual(env.statuses, [["pstack", "poteto:why"]]);
});

test("poteto input transforms a strong match and arms readonly for investigation", () => {
  const env = fakeEnvironment();
  const armed = liveList<string>();
  createPotetoRuntime(env.pi, {
    armReadonly: (_ctx: unknown, reason: string) => armed.add(reason),
  });
  const ctx = { ui: env.ui };
  const transformed = env.handler("input")({ source: "interactive", text: "check on PR #12" }, ctx);
  assert.deepEqual(transformed, {
    action: "transform",
    text: "/skill:poteto-mode playbooks/babysit check on PR #12",
  });
  assert.deepEqual(armed.all(), []);

  const investigation = env.handler("input")(
    { source: "interactive", text: "/skill:poteto-mode playbooks/investigation why is the build slow" },
    ctx,
  );
  assert.equal(armed.all().includes("skill:investigation"), true);
  assert.equal(investigation === undefined || investigation.action === "transform", true);
});

test("a casual turn keeps the ongoing playbook and a strong match reassigns it", () => {
  const env = fakeEnvironment();
  const runtime = createPotetoRuntime(env.pi, { armReadonly: () => {} });
  const ctx = { ui: env.ui };
  env.handler("input")({ source: "interactive", text: "babysit this PR and get it green" }, ctx);
  assert.equal(runtime.getState().matchedPlaybookId, "babysit");

  const casual = env.handler("input")({ source: "interactive", text: "maybe refactor this later" }, ctx);
  assert.equal(runtime.getState().matchedPlaybookId, "babysit", "casual turn must not reassign");
  assert.equal(casual, undefined, "casual turn must not force another playbook");

  const strong = env.handler("input")(
    { source: "interactive", text: "refactor and rename these helpers, behavior-preserving" },
    ctx,
  );
  assert.equal(runtime.getState().matchedPlaybookId, "refactoring");
  assert.equal(strong?.action, "transform");
});

test("a strong non-investigation task releases a playbook-armed readonly session", () => {
  const env = fakeEnvironment();
  const armed = liveList<string>();
  const released = liveList<string>();
  createPotetoRuntime(env.pi, {
    armReadonly: (_ctx: unknown, reason: string) => armed.add(reason),
    releaseReadonly: () => released.add("released"),
  });
  const ctx = { ui: env.ui };
  env.handler("input")(
    { source: "interactive", text: "/skill:poteto-mode playbooks/investigation why is the build slow" },
    ctx,
  );
  assert.equal(armed.all().includes("skill:investigation"), true);

  env.handler("input")({ source: "interactive", text: "investigate why the builds are slow" }, ctx);
  assert.deepEqual(released.all(), [], "an investigation match keeps readonly armed");

  env.handler("input")(
    { source: "interactive", text: "refactor and rename these helpers, behavior-preserving" },
    ctx,
  );
  assert.deepEqual(released.all(), ["released"], "a strong new task releases the arm");
});

test("poteto input ignores non-user provenance", () => {
  const env = fakeEnvironment();
  createPotetoRuntime(env.pi, { armReadonly: () => {} });
  const result = env.handler("input")({ source: "extension", text: "check on PR #12" }, { ui: env.ui });
  assert.equal(result, undefined);
  assert.deepEqual(env.entries, []);
});

test("poteto prompt handler adds the sticky body when armed", () => {
  const env = fakeEnvironment();
  createPotetoRuntime(env.pi, { armReadonly: () => {} });
  env.handler("session_start")(
    {},
    {
      sessionManager: {
        getBranch: () => [
          { type: "custom", customType: "pstack-poteto-mode", data: { enabled: true, matchedPlaybookId: null } },
        ],
      },
      ui: env.ui,
    },
  );
  const result = env.handler("before_agent_start")({ systemPrompt: "SYS" });
  assert.equal(result.systemPrompt.includes("SYS"), true);
  assert.equal(result.systemPrompt.includes("## Poteto mode (sticky — re-injected each turn)"), true);
});

test("poteto-mode-off clears state and status", () => {
  const env = fakeEnvironment();
  const runtime = createPotetoRuntime(env.pi, { armReadonly: () => {} });
  env.commands.get("poteto-mode").handler("", { ui: env.ui });
  assert.equal(runtime.getState().enabled, true);
  env.commands.get("poteto-mode-off").handler("", { ui: env.ui });
  assert.equal(runtime.getState().enabled, false);
  assert.equal(env.statuses.some(([id, value]) => id === "pstack" && value === undefined), true);
});

test("readonly runtime strips write tools and restores them on disable", () => {
  const env = fakeEnvironment({
    allTools: ["read", "grep", "find", "ls", "write", "bash", "pstack_spawn"],
    activeTools: ["read", "write", "bash", "pstack_spawn"],
  });
  const runtime = createReadonlyRuntime(env.pi);
  env.commands.get("pstack-readonly").handler("", { ui: env.ui });
  assert.deepEqual(runtime.getState(), {
    enabled: true,
    toolsBefore: ["read", "write", "bash", "pstack_spawn"],
    reason: "command",
  });
  assert.deepEqual(env.activeTools.at(-1), ["read", "grep", "find", "ls", "pstack_spawn"]);
  assert.deepEqual(env.entries.at(-1), {
    entryType: "pstack-session-readonly",
    payload: { enabled: true, reason: "command", updatedAt: env.entries.at(-1).payload.updatedAt },
  });
  assert.equal(env.statuses.some(([id, value]) => id === "pstack-ro" && value === "readonly"), true);

  env.commands.get("pstack-readonly-off").handler("", { ui: env.ui });
  assert.deepEqual(runtime.getState(), { enabled: false, toolsBefore: undefined, reason: undefined });
  assert.deepEqual(env.activeTools.at(-1), ["read", "write", "bash", "pstack_spawn"]);
  assert.equal(env.statuses.some(([id, value]) => id === "pstack-ro" && value === undefined), true);
});

test("readonly tool_call blocks writes and coerces non-investigator spawns", () => {
  const env = fakeEnvironment();
  createReadonlyRuntime(env.pi);
  env.commands.get("pstack-readonly").handler("", { ui: env.ui });
  const toolCall = env.handler("tool_call");
  assert.deepEqual(toolCall({ toolName: "bash" }), {
    block: true,
    reason: "pstack session readonly: blocked bash. Use /pstack-readonly-off to re-enable writes.",
  });
  assert.equal(toolCall({ toolName: "read" }), undefined);
  assert.deepEqual(toolCall({ toolName: "pstack_worktree", input: { action: "create" } }), {
    block: true,
    reason: "pstack session readonly: blocked mutating pstack_worktree.",
  });
  assert.equal(toolCall({ toolName: "pstack_worktree", input: { action: "list" } }), undefined);
  assert.deepEqual(toolCall({ toolName: "pstack_ship" }), {
    block: true,
    reason: "pstack session readonly: blocked pstack_ship.",
  });
  const spawnInput = { role: "general" };
  assert.equal(toolCall({ toolName: "pstack_spawn", input: spawnInput }), undefined);
  assert.equal((spawnInput as any).readonly, true);
  const investigator = { role: "investigator" };
  toolCall({ toolName: "pstack_spawn", input: investigator });
  assert.equal((investigator as any).readonly, undefined);
});

test("readonly tool_call is inert before the command arms it", () => {
  const env = fakeEnvironment();
  createReadonlyRuntime(env.pi);
  assert.equal(env.handler("tool_call")({ toolName: "bash" }), undefined);
});
