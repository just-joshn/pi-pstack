import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  READONLY_TOOL_POLICIES,
  computeReadonlyTools,
  createInitialReadonlyState,
  reduceSetEnabled,
} from "../../../extensions/readonly-state/index.ts";
import { READONLY_TOOLS } from "../../../extensions/subagents/child-runner.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const ALL = ["read", "grep", "find", "ls", "write", "bash", "pstack_spawn", "pstack_ship"];
const WRITE_BLOCKED = new Set(["write", "bash", "pstack_ship"]);
const universe = { allTools: ALL, activeTools: [...ALL] };

test("computeReadonlyTools remembers the active set and strips write-blocked tools", () => {
  const result = computeReadonlyTools(ALL, ["write", "bash", "pstack_spawn"], WRITE_BLOCKED);
  assert.deepEqual(result.toolsBefore, ["write", "bash", "pstack_spawn"]);
  assert.deepEqual(result.nextActive, ["read", "grep", "find", "ls", "pstack_spawn"]);
});

test("computeReadonlyTools falls back to all tools when none are active and keeps the read allowlist", () => {
  const result = computeReadonlyTools(["read", "write"], [], WRITE_BLOCKED);
  assert.deepEqual(result.toolsBefore, ["read", "write"]);
  assert.deepEqual(result.nextActive, ["read", "grep", "find", "ls"]);
});

test("computeReadonlyTools keeps read-only pstack tools and drops blocked ones", () => {
  const { nextActive } = computeReadonlyTools(ALL, [...ALL], WRITE_BLOCKED);
  assert.equal(nextActive.includes("pstack_spawn"), true);
  assert.equal(nextActive.includes("pstack_ship"), false);
  assert.equal(nextActive.includes("write"), false);
  assert.equal(nextActive.includes("bash"), false);
});

test("reduceSetEnabled enabling returns the stripped active set and a readonly status", () => {
  const result = reduceSetEnabled(createInitialReadonlyState(), true, universe, "command");
  assert.deepEqual(result.state, { enabled: true, toolsBefore: [...ALL], reason: "command" });
  assert.deepEqual(result.effects.map((effect) => effect.type), [
    "appendEntry",
    "setActiveTools",
    "setStatus",
    "notify",
  ]);
  const status = result.effects.find((effect) => effect.type === "setStatus");
  assert.deepEqual(status, { type: "setStatus", statusId: "pstack-ro", value: "readonly" });
});

test("reduceSetEnabled disabling restores the remembered tools through the guarded effect", () => {
  const armed = reduceSetEnabled(createInitialReadonlyState(), true, universe, "command").state;
  const result = reduceSetEnabled(armed, false, universe);
  assert.deepEqual(result.state, { enabled: false, toolsBefore: undefined, reason: undefined });
  const restore = result.effects.find((effect) => effect.type === "setActiveTools");
  assert.deepEqual(restore, { type: "setActiveTools", tools: [...ALL], guarded: true });
  const status = result.effects.find((effect) => effect.type === "setStatus");
  assert.deepEqual(status, { type: "setStatus", statusId: "pstack-ro", value: undefined });
});

test("reduceSetEnabled is a no-op when the flag is unchanged", () => {
  const state = createInitialReadonlyState();
  const result = reduceSetEnabled(state, false, universe);
  assert.equal(result.state, state);
  assert.deepEqual(result.effects, []);
});

test("computeReadonlyTools preserves the read allowlist when the registry narrows", () => {
  const { nextActive } = computeReadonlyTools(["read", "pstack_sessions"], ["read"], WRITE_BLOCKED);
  for (const tool of READONLY_TOOLS) {
    assert.ok(nextActive.includes(tool), `${tool} must survive the keep-set filter`);
  }
});

test("readonly policy blocks exec, writers, fan-out, and frame mutations", () => {
  const action = (tool: string, input: unknown) => READONLY_TOOL_POLICIES[tool](input).action;
  assert.equal(action("bash", {}), "block");
  assert.equal(action("pstack_loop", { action: "arm", prompt: "x" }), "block");
  assert.equal(action("pstack_loop", {}), "block");
  assert.equal(action("pstack_loop", { action: "status" }), "allow");
  assert.equal(action("pstack_loop", { action: "list" }), "allow");
  assert.equal(action("pstack_loop", { action: "stop" }), "allow");
  assert.equal(action("pstack_decision_log", { phase: "x" }), "block");
  assert.equal(action("pstack_benny_wake", { action: "append" }), "block");
  assert.equal(action("pstack_benny_wake", { action: "drain" }), "block");
  assert.equal(action("pstack_benny_wake", { action: "path" }), "allow");
  assert.equal(action("pstack_swarm", { workers: [] }), "block");
  assert.equal(action("pstack_arena", { prompt: "x", candidates: [] }), "block");
  assert.equal(action("pstack_control_cli", { argv: ["git", "status"] }), "block");
  assert.equal(action("pstack_spawn", { task: "x" }), "coerceReadonly");
  assert.equal(action("pstack_spawn", { task: "x", readonly: true }), "allow");
  assert.equal(action("pstack_spawn", { task: "x", role: "investigator" }), "allow");
  assert.equal(action("pstack_sessions", { action: "list" }), "allow");
});

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

function registeredPstackTools(): string[] {
  const names = walkFiles(join(ROOT, "extensions"))
    .filter((path) => path.endsWith(".ts"))
    .flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/name:\s*"(pstack_[a-z_]+)"/g)].map((match) => match[1]),
    );
  return [...new Set(names)].toSorted();
}

test("every registered pstack tool has a readonly policy", () => {
  const tools = registeredPstackTools();
  assert.ok(tools.length >= 14, `expected the pstack tool surface, found ${tools.length}`);
  for (const tool of tools) {
    assert.ok(tool in READONLY_TOOL_POLICIES, `${tool} has no readonly policy`);
  }
});
