import { afterAll, expect, test } from "vitest";
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
afterAll(() => {
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
  expect(env.entries).toEqual([{ entryType: "x", payload: { a: 1 } }]);
  expect(env.statuses).toEqual([["s", "v"], ["notify", "info:hello"]]);
  expect(env.activeTools).toEqual([["read"]]);
});

test("applyEffects tolerates a missing ui notify", () => {
  const env = fakeEnvironment();
  const uiWithoutNotify = { setStatus: env.ui.setStatus };
  applyEffects(env.pi, { ui: uiWithoutNotify as any }, [{ type: "notify", message: "ignored", level: "info" }]);
  expect(env.statuses).toEqual([]);
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
  expect(env.statuses).toEqual([["s", "v"]]);
  expect(() => applyEffects(throwingPi, { ui: env.ui }, [{ type: "setActiveTools", tools: ["read"] }])).toThrow(/session tearing down/);
});

test("matchPlaybook returns undefined for empty and unmatched text", () => {
  expect(matchPlaybook("")).toBe(undefined);
  expect(matchPlaybook("   ")).toBe(undefined);
  expect(matchPlaybook("what time is it")).toBe(undefined);
});

test("matchPlaybook matches by cue and by explicit playbook path", () => {
  expect(matchPlaybook("babysit this PR")?.id).toBe("babysit");
  expect(matchPlaybook("check on PR #12")?.id).toBe("babysit");
  expect(matchPlaybook("follow playbooks/bug-fix now")?.id).toBe("bug-fix");
  expect(matchPlaybook("bugbot"), "a bare bugbot mention is not a PR-status request").toBe(undefined);
  expect(matchPlaybook("bugbot commented on the PR")?.id).toBe("babysit");
});

test("playbook lookup helpers report known and unknown ids", () => {
  expect(playbookMatchFromId("babysit")).toEqual({
    id: "babysit",
    file: "babysit.md",
    score: 0,
    priority: 100,
  });
  expect(playbookMatchFromId("no-such-playbook")).toBe(undefined);
  const ids = listPlaybookIds();
  expect(ids.includes("babysit")).toBe(true);
  expect(ids.includes("no-such-playbook")).toBe(false);
});

test("loadPlaybookBody loads the stripped body and reports a missing file", () => {
  const body = loadPlaybookBody("babysit");
  expect(body.startsWith("---")).toBe(false);
  expect(body.length > 100).toBe(true);
  expect(loadPlaybookBody("no-such-playbook")).toMatch(/playbook missing/);
});

test("buildPlaybookInjectFromId marks restored and matched blocks", () => {
  const restored = buildPlaybookInjectFromId("babysit", { restored: true });
  expect(restored?.includes("## Restored sticky playbook (steps reinjected)")).toBe(true);
  expect(restored?.includes("Open a todolist")).toBe(true);
  expect(buildPlaybookInjectFromId("no-such-playbook")).toBe(undefined);
  const block = buildPlaybookInjectBlock(playbookMatchFromId("babysit")!);
  expect(block.includes("## Matched playbook (sticky routing — forced)")).toBe(true);
});

test("stripFrontmatter removes the block and leaves plain input trimmed", () => {
  expect(stripFrontmatter("---\nname: x\n---\nbody\n")).toBe("body");
  expect(stripFrontmatter("plain text\n")).toBe("plain text");
  expect(stripFrontmatter("---\nunclosed\n")).toBe("---\nunclosed");
});

test("buildPotetoStickyPrompt injects the skill body and the routing tail", () => {
  const plain = buildPotetoStickyPrompt("BASE");
  expect(plain.includes("BASE")).toBe(true);
  expect(plain.includes("## Poteto mode (sticky — re-injected each turn)")).toBe(true);
  expect(plain.includes("## Sticky playbook routing")).toBe(true);
  const matched = buildPotetoStickyPrompt("BASE", {
    match: { id: "babysit", file: "babysit.md", path: "/p/babysit.md", score: 5, priority: 100 },
  });
  expect(matched.includes("## Matched playbook (sticky routing — forced)")).toBe(true);
  const restored = buildPotetoStickyPrompt("BASE", { restoredPlaybookId: "babysit" });
  expect(restored.includes("## Restored sticky playbook (steps reinjected)")).toBe(true);
});

test("matchStickyPlaybook delegates to the matcher", () => {
  expect(matchStickyPlaybook("babysit PR 9")?.id).toBe("babysit");
  expect(matchStickyPlaybook("unrelated")).toBe(undefined);
});

test("poteto runtime restores a persisted playbook on session_start", () => {
  const env = fakeEnvironment();
  const runtime = createPotetoRuntime(env.pi, { armReadonly: () => {} });
  const branch = [
    { type: "custom", customType: "pstack-poteto-mode", data: { enabled: true, matchedPlaybookId: "why" } },
  ];
  env.handler("session_start")({}, { sessionManager: { getBranch: () => branch }, ui: env.ui });
  expect(runtime.getState()).toEqual({
    enabled: true,
    matchedPlaybookId: "why",
    matchedScore: 0,
    assignedThisTurn: false,
    lastUserText: "",
  });
  expect(env.statuses).toEqual([["pstack", "poteto:why"]]);
});

test("poteto input transforms a strong match and arms readonly for investigation", () => {
  const env = fakeEnvironment();
  const armed = liveList<string>();
  createPotetoRuntime(env.pi, {
    armReadonly: (_ctx: unknown, reason: string) => armed.add(reason),
  });
  const ctx = { ui: env.ui };
  const transformed = env.handler("input")({ source: "interactive", text: "check on PR #12" }, ctx);
  expect(transformed).toEqual({
    action: "transform",
    text: "/skill:poteto-mode playbooks/babysit check on PR #12",
  });
  expect(armed.all()).toEqual([]);

  const investigation = env.handler("input")(
    { source: "interactive", text: "/skill:poteto-mode playbooks/investigation why is the build slow" },
    ctx,
  );
  expect(armed.all().includes("skill:investigation")).toBe(true);
  expect(investigation === undefined || investigation.action === "transform").toBe(true);
});

test("a casual turn keeps the ongoing playbook and a strong match reassigns it", () => {
  const env = fakeEnvironment();
  const runtime = createPotetoRuntime(env.pi, { armReadonly: () => {} });
  const ctx = { ui: env.ui };
  env.handler("input")({ source: "interactive", text: "babysit this PR and get it green" }, ctx);
  expect(runtime.getState().matchedPlaybookId).toBe("babysit");

  const casual = env.handler("input")({ source: "interactive", text: "maybe refactor this later" }, ctx);
  expect(runtime.getState().matchedPlaybookId, "casual turn must not reassign").toBe("babysit");
  expect(casual, "casual turn must not force another playbook").toBe(undefined);

  const strong = env.handler("input")(
    { source: "interactive", text: "refactor and rename these helpers, behavior-preserving" },
    ctx,
  );
  expect(runtime.getState().matchedPlaybookId).toBe("refactoring");
  expect(strong?.action).toBe("transform");
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
  expect(armed.all().includes("skill:investigation")).toBe(true);

  env.handler("input")({ source: "interactive", text: "investigate why the builds are slow" }, ctx);
  expect(released.all(), "an investigation match keeps readonly armed").toEqual([]);

  env.handler("input")(
    { source: "interactive", text: "refactor and rename these helpers, behavior-preserving" },
    ctx,
  );
  expect(released.all(), "a strong new task releases the arm").toEqual(["released"]);
});

test("poteto input ignores non-user provenance", () => {
  const env = fakeEnvironment();
  createPotetoRuntime(env.pi, { armReadonly: () => {} });
  const result = env.handler("input")({ source: "extension", text: "check on PR #12" }, { ui: env.ui });
  expect(result).toBe(undefined);
  expect(env.entries).toEqual([]);
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
  expect(result.systemPrompt.includes("SYS")).toBe(true);
  expect(result.systemPrompt.includes("## Poteto mode (sticky — re-injected each turn)")).toBe(true);
});

test("poteto-mode-off clears state and status", () => {
  const env = fakeEnvironment();
  const runtime = createPotetoRuntime(env.pi, { armReadonly: () => {} });
  env.commands.get("poteto-mode").handler("", { ui: env.ui });
  expect(runtime.getState().enabled).toBe(true);
  env.commands.get("poteto-mode-off").handler("", { ui: env.ui });
  expect(runtime.getState().enabled).toBe(false);
  expect(env.statuses.some(([id, value]) => id === "pstack" && value === undefined)).toBe(true);
});

test("readonly runtime strips write tools and restores them on disable", () => {
  const env = fakeEnvironment({
    allTools: ["read", "grep", "find", "ls", "write", "bash", "pstack_spawn"],
    activeTools: ["read", "write", "bash", "pstack_spawn"],
  });
  const runtime = createReadonlyRuntime(env.pi);
  env.commands.get("pstack-readonly").handler("", { ui: env.ui });
  expect(runtime.getState()).toEqual({
    enabled: true,
    toolsBefore: ["read", "write", "bash", "pstack_spawn"],
    reason: "command",
  });
  expect(env.activeTools.at(-1)).toEqual(["read", "grep", "find", "ls", "pstack_spawn"]);
  expect(env.entries.at(-1)).toEqual({
    entryType: "pstack-session-readonly",
    payload: { enabled: true, reason: "command", updatedAt: env.entries.at(-1).payload.updatedAt },
  });
  expect(env.statuses.some(([id, value]) => id === "pstack-ro" && value === "readonly")).toBe(true);

  env.commands.get("pstack-readonly-off").handler("", { ui: env.ui });
  expect(runtime.getState()).toEqual({ enabled: false, toolsBefore: undefined, reason: undefined });
  expect(env.activeTools.at(-1)).toEqual(["read", "write", "bash", "pstack_spawn"]);
  expect(env.statuses.some(([id, value]) => id === "pstack-ro" && value === undefined)).toBe(true);
});

test("readonly tool_call blocks writes and coerces non-investigator spawns", () => {
  const env = fakeEnvironment();
  createReadonlyRuntime(env.pi);
  env.commands.get("pstack-readonly").handler("", { ui: env.ui });
  const toolCall = env.handler("tool_call");
  expect(toolCall({ toolName: "bash" })).toEqual({
    block: true,
    reason: "pstack session readonly: blocked bash. Use /pstack-readonly-off to re-enable writes.",
  });
  expect(toolCall({ toolName: "read" })).toBe(undefined);
  expect(toolCall({ toolName: "pstack_worktree", input: { action: "create" } })).toEqual({
    block: true,
    reason: "pstack session readonly: blocked mutating pstack_worktree.",
  });
  expect(toolCall({ toolName: "pstack_worktree", input: { action: "list" } })).toBe(undefined);
  expect(toolCall({ toolName: "pstack_ship" })).toEqual({
    block: true,
    reason: "pstack session readonly: blocked pstack_ship.",
  });
  const spawnInput = { role: "general" };
  expect(toolCall({ toolName: "pstack_spawn", input: spawnInput })).toBe(undefined);
  expect((spawnInput as any).readonly).toBe(true);
  const investigator = { role: "investigator" };
  toolCall({ toolName: "pstack_spawn", input: investigator });
  expect((investigator as any).readonly).toBe(undefined);
});

test("readonly tool_call is inert before the command arms it", () => {
  const env = fakeEnvironment();
  createReadonlyRuntime(env.pi);
  expect(env.handler("tool_call")({ toolName: "bash" })).toBe(undefined);
});
