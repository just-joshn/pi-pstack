import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeReadonlyTools,
  createInitialReadonlyState,
  reduceSetEnabled,
} from "../../../extensions/readonly-state/index.ts";

const ALL = ["read", "grep", "find", "ls", "write", "bash", "pstack_spawn", "pstack_ship"];
const WRITE_BLOCKED = new Set(["write", "bash", "pstack_ship"]);
const universe = { allTools: ALL, activeTools: [...ALL] };

test("computeReadonlyTools remembers the active set and strips write-blocked tools", () => {
  const result = computeReadonlyTools(ALL, ["write", "bash", "pstack_spawn"], WRITE_BLOCKED);
  assert.deepEqual(result.toolsBefore, ["write", "bash", "pstack_spawn"]);
  assert.deepEqual(result.nextActive, ["read", "grep", "find", "ls", "pstack_spawn"]);
});

test("computeReadonlyTools falls back to all tools when none are active", () => {
  const result = computeReadonlyTools(["read", "write"], [], WRITE_BLOCKED);
  assert.deepEqual(result.toolsBefore, ["read", "write"]);
  assert.deepEqual(result.nextActive, ["read"]);
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
  assert.deepEqual(result.state, { enabled: true, toolsBefore: [...ALL] });
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
  assert.deepEqual(result.state, { enabled: false, toolsBefore: undefined });
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
