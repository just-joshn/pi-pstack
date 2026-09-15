/**
 * Repro + regression test: the "input" handler in extensions/index.ts must not match,
 * persist, force-invoke, or arm readonly on extension-injected text (event.source === "extension").
 * Drives the real default export, not a reimplementation.
 * Run: node --experimental-strip-types --import ./extensions/test/peer-deps.mjs extensions/test/sticky-input-source.mjs
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let failed = 0;

// The handler gates auto-readonly on PSTACK_CHILD_ROLE; this test simulates a real
// parent session (unset even when this test itself runs as a pstack child).
delete process.env.PSTACK_CHILD_ROLE;

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}:`, err?.message ?? err);
  }
}

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
        appended.push({ type, data });
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
        calls.setActiveTools.push(names);
      },
      sendUserMessage(msg, opts) {
        calls.sendUserMessage.push({ msg, opts });
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

await check("shouldMatchStickyInput: extension is rejected, interactive/rpc allowed", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-session.ts")).href);
  assert.equal(mod.shouldMatchStickyInput("extension"), false);
  assert.equal(mod.shouldMatchStickyInput("interactive"), true);
  assert.equal(mod.shouldMatchStickyInput("rpc"), true);
  assert.equal(mod.shouldMatchStickyInput(undefined), true);
});

await check("interactive input matches bug-fix and does not arm readonly", async () => {
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
  assert.ok(matched, `expected a pstack-poteto-mode entry matching bug-fix, got: ${JSON.stringify(appended)}`);
  const readonly = appended.find((e) => e.type === "pstack-session-readonly");
  assert.equal(readonly, undefined, `expected no readonly entry for bug-fix, got: ${JSON.stringify(readonly)}`);
});

await check("extension-injected input does not match, persist, force-invoke, or arm readonly", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/index.ts")).href);
  const { api, handlers, appended, calls } = makeFakeApi();
  mod.default(api);

  // Case 1: real user turn, matches bug-fix (sanity + "overwrite would show up" setup).
  await handlers.input(
    { type: "input", text: "playbooks/bug-fix please deep audit", source: "interactive" },
    fakeCtx(),
  );
  const before = appended.filter((e) => e.type === "pstack-poteto-mode");
  assert.ok(before.length >= 1);
  assert.equal(before.at(-1).data.matchedPlaybookId, "bug-fix");

  // Case 2: extension-injected text must be fully ignored.
  const appendedCountBefore = appended.length;
  const sendCountBefore = calls.sendUserMessage.length;
  const setActiveCountBefore = calls.setActiveTools.length;
  await handlers.input(
    { type: "input", text: "playbooks/investigation how does it work", source: "extension" },
    fakeCtx(),
  );
  assert.equal(appended.length, appendedCountBefore, `extension input must not appendEntry, got: ${JSON.stringify(appended.slice(appendedCountBefore))}`);
  assert.equal(calls.sendUserMessage.length, sendCountBefore, "extension input must not call sendUserMessage");
  assert.equal(calls.setActiveTools.length, setActiveCountBefore, "extension input must not call setActiveTools");

  // The matched playbook from the real user turn must still be bug-fix, not overwritten.
  const potetoEntries = appended.filter((e) => e.type === "pstack-poteto-mode");
  assert.equal(potetoEntries.at(-1).data.matchedPlaybookId, "bug-fix");
});

await check("interactive investigation text still arms readonly for real users", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/index.ts")).href);
  const { api, handlers, appended } = makeFakeApi();
  mod.default(api);
  await handlers.input(
    { type: "input", text: "how does the auth middleware work? investigate please", source: "interactive" },
    fakeCtx(),
  );
  const readonly = appended.find((e) => e.type === "pstack-session-readonly");
  assert.ok(readonly, `expected a readonly entry, got: ${JSON.stringify(appended)}`);
  assert.equal(readonly.data.reason, "playbook:investigation");
});

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll checks passed");
}
