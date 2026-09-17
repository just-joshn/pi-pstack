/**
 * Repro + regression test: the "input" handler in extensions/index.ts must not match,
 * persist, force-invoke, or arm readonly on extension-injected text (event.source === "extension").
 * Drives the real default export, not a reimplementation.
 * Run: npx vitest run --project extensions
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The handler gates auto-readonly on PSTACK_CHILD_ROLE; this test simulates a real
// parent session (unset even when this test itself runs as a pstack child).
Reflect.deleteProperty(process.env, "PSTACK_CHILD_ROLE");

const ALL_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "bash",
  "powershell",
  "pstack_spawn",
  "pstack_jobs",
  "pstack_swarm",
  "pstack_arena",
  "pstack_loop",
  "pstack_deslop",
  "pstack_ship",
  "pstack_babysit",
];

function makeFakeApi() {
  const handlers = {};
  const appended = [];
  const calls = { sendUserMessage: [], setActiveTools: [] };
  const api = new Proxy(
    {
      on(name, fn) {
        handlers[name] = fn;
      },
      appendEntry(type, data) {
        appended[appended.length] = { type, data };
      },
      registerCommand() {},
      registerTool() {},
      getAllTools() {
        return ALL_TOOL_NAMES.map((name) => ({ name }));
      },
      getActiveTools() {
        return [];
      },
      setActiveTools(names) {
        calls.setActiveTools = [...calls.setActiveTools, names];
      },
      sendUserMessage(msg, opts) {
        calls.sendUserMessage = [...calls.sendUserMessage, { msg, opts }];
      },
      sendMessage() {},
      async exec() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => {};
      },
    },
  );
  return { api, handlers, appended, calls };
}

function fakeCtx() {
  return {
    ui: {
      setStatus() {},
      notify() {},
    },
  };
}

test("shouldMatchStickyInput: extension is rejected, interactive/rpc allowed", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-session.ts")).href);
  expect(mod.shouldMatchStickyInput("extension")).toBe(false);
  expect(mod.shouldMatchStickyInput("interactive")).toBe(true);
  expect(mod.shouldMatchStickyInput("rpc")).toBe(true);
  expect(mod.shouldMatchStickyInput(undefined)).toBe(true);
});

test("interactive input matches bug-fix and does not arm readonly", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/index.ts")).href);
  const { api, handlers, appended } = makeFakeApi();
  mod.default(api);
  await handlers.input(
    { type: "input", text: "playbooks/bug-fix please deep audit", source: "interactive" },
    fakeCtx(),
  );
  const matched = appended.find(
    (e) => e.type === "pstack-poteto-mode" && e.data.matchedPlaybookId === "bug-fix",
  );
  expect(matched, `expected a pstack-poteto-mode entry matching bug-fix, got: ${JSON.stringify(appended)}`).toBeTruthy();
  const readonly = appended.find((e) => e.type === "pstack-session-readonly");
  expect(readonly, `expected no readonly entry for bug-fix, got: ${JSON.stringify(readonly)}`).toBe(undefined);
});

test("interactive matching input returns transform action (no queued follow-up)", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/index.ts")).href);
  const { api, handlers, calls } = makeFakeApi();
  mod.default(api);
  const result = await handlers.input(
    { type: "input", text: "playbooks/bug-fix please deep audit", source: "interactive" },
    fakeCtx(),
  );
  expect(result).toEqual({
    action: "transform",
    text: "/skill:poteto-mode playbooks/bug-fix please deep audit",
  });
  expect(calls.sendUserMessage.length, "must not call sendUserMessage; transform replaces the queued follow-up").toBe(0);
});

test("extension-injected input does not match, persist, force-invoke, or arm readonly", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/index.ts")).href);
  const { api, handlers, appended, calls } = makeFakeApi();
  mod.default(api);

  // Case 1: real user turn, matches bug-fix (sanity + "overwrite would show up" setup).
  await handlers.input(
    { type: "input", text: "playbooks/bug-fix please deep audit", source: "interactive" },
    fakeCtx(),
  );
  const before = appended.filter((e) => e.type === "pstack-poteto-mode");
  expect(before.length >= 1).toBeTruthy();
  expect(before.at(-1).data.matchedPlaybookId).toBe("bug-fix");

  // Case 2: extension-injected text must be fully ignored.
  const appendedCountBefore = appended.length;
  const sendCountBefore = calls.sendUserMessage.length;
  const setActiveCountBefore = calls.setActiveTools.length;
  await handlers.input(
    { type: "input", text: "playbooks/investigation how does it work", source: "extension" },
    fakeCtx(),
  );
  expect(appended.length, `extension input must not appendEntry, got: ${JSON.stringify(appended.slice(appendedCountBefore))}`).toBe(appendedCountBefore);
  expect(calls.sendUserMessage.length, "extension input must not call sendUserMessage").toBe(sendCountBefore);
  expect(calls.setActiveTools.length, "extension input must not call setActiveTools").toBe(setActiveCountBefore);

  // The matched playbook from the real user turn must still be bug-fix, not overwritten.
  const potetoEntries = appended.filter((e) => e.type === "pstack-poteto-mode");
  expect(potetoEntries.at(-1).data.matchedPlaybookId).toBe("bug-fix");
});

test("interactive investigation text still arms readonly for real users", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/index.ts")).href);
  const { api, handlers, appended } = makeFakeApi();
  mod.default(api);
  await handlers.input(
    { type: "input", text: "how does the auth middleware work? investigate please", source: "interactive" },
    fakeCtx(),
  );
  const readonly = appended.find((e) => e.type === "pstack-session-readonly");
  expect(readonly, `expected a readonly entry, got: ${JSON.stringify(appended)}`).toBeTruthy();
  expect(readonly.data.reason).toBe("playbook:investigation");
});
