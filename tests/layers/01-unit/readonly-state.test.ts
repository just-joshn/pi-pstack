import { expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/repo-root.mjs";
import {
  READONLY_TOOL_POLICIES,
  computeReadonlyTools,
  createInitialReadonlyState,
  reduceSetEnabled,
} from "../../../extensions/readonly-state/index.ts";
import { READONLY_TOOLS } from "../../../extensions/subagents/child-runner.ts";

const ROOT = repoRoot(import.meta.url);

const ALL = ["read", "grep", "find", "ls", "write", "bash", "pstack_spawn", "pstack_ship"];
const WRITE_BLOCKED = new Set(["write", "bash", "pstack_ship"]);
const universe = { allTools: ALL, activeTools: [...ALL] };

test("computeReadonlyTools remembers the active set and strips write-blocked tools", () => {
  const result = computeReadonlyTools(ALL, ["write", "bash", "pstack_spawn"], WRITE_BLOCKED);
  expect(result.toolsBefore).toEqual(["write", "bash", "pstack_spawn"]);
  expect(result.nextActive).toEqual(["read", "grep", "find", "ls", "pstack_spawn"]);
});

test("computeReadonlyTools falls back to all tools when none are active and keeps the read allowlist", () => {
  const result = computeReadonlyTools(["read", "write"], [], WRITE_BLOCKED);
  expect(result.toolsBefore).toEqual(["read", "write"]);
  expect(result.nextActive).toEqual(["read", "grep", "find", "ls"]);
});

test("computeReadonlyTools keeps read-only pstack tools and drops blocked ones", () => {
  const { nextActive } = computeReadonlyTools(ALL, [...ALL], WRITE_BLOCKED);
  expect(nextActive.includes("pstack_spawn")).toBe(true);
  expect(nextActive.includes("pstack_ship")).toBe(false);
  expect(nextActive.includes("write")).toBe(false);
  expect(nextActive.includes("bash")).toBe(false);
});

test("computeReadonlyTools preserves an unrelated tool and strips only write-blocked tools", () => {
  const result = computeReadonlyTools(
    ["read", "webfetch", "pstack_ship", "write"],
    ["read", "webfetch", "pstack_ship", "write"],
    WRITE_BLOCKED,
  );
  expect(result.nextActive).toEqual(["read", "grep", "find", "ls", "webfetch"]);
  expect(result.nextActive.includes("pstack_ship")).toBe(false);
  expect(result.nextActive.includes("write")).toBe(false);
});

test("reduceSetEnabled disabling unions the pre-arm snapshot with tools added while readonly", () => {
  const armed = reduceSetEnabled(
    createInitialReadonlyState(),
    true,
    { allTools: ALL, activeTools: ["read", "write"] },
    "command",
  ).state;
  expect(armed.toolsBefore).toEqual(["read", "write"]);
  const result = reduceSetEnabled(armed, false, { allTools: ALL, activeTools: ["read", "webfetch"] });
  const restore = result.effects.find((effect) => effect.type === "setActiveTools");
  expect(restore).toEqual({
    type: "setActiveTools",
    tools: ["read", "write", "webfetch"],
    guarded: true,
  });
});

test("reduceSetEnabled enabling returns the stripped active set and a readonly status", () => {
  const result = reduceSetEnabled(createInitialReadonlyState(), true, universe, "command");
  expect(result.state).toEqual({ enabled: true, toolsBefore: [...ALL], reason: "command" });
  expect(result.effects.map((effect) => effect.type)).toEqual([
    "appendEntry",
    "setActiveTools",
    "setStatus",
    "notify",
  ]);
  const status = result.effects.find((effect) => effect.type === "setStatus");
  expect(status).toEqual({ type: "setStatus", statusId: "pstack-ro", value: "readonly" });
});

test("reduceSetEnabled disabling restores the remembered tools through the guarded effect", () => {
  const armed = reduceSetEnabled(createInitialReadonlyState(), true, universe, "command").state;
  const result = reduceSetEnabled(armed, false, universe);
  expect(result.state).toEqual({ enabled: false, toolsBefore: undefined, reason: undefined });
  const restore = result.effects.find((effect) => effect.type === "setActiveTools");
  expect(restore).toEqual({ type: "setActiveTools", tools: [...ALL], guarded: true });
  const status = result.effects.find((effect) => effect.type === "setStatus");
  expect(status).toEqual({ type: "setStatus", statusId: "pstack-ro", value: undefined });
});

test("reduceSetEnabled is a no-op when the flag is unchanged", () => {
  const state = createInitialReadonlyState();
  const result = reduceSetEnabled(state, false, universe);
  expect(result.state).toBe(state);
  expect(result.effects).toEqual([]);
});

test("computeReadonlyTools preserves the read allowlist when the registry narrows", () => {
  const { nextActive } = computeReadonlyTools(["read", "pstack_sessions"], ["read"], WRITE_BLOCKED);
  for (const tool of READONLY_TOOLS) {
    expect(nextActive.includes(tool), `${tool} must survive the keep-set filter`).toBeTruthy();
  }
});

test("readonly policy blocks exec, writers, fan-out, and frame mutations", () => {
  const action = (tool: string, input: unknown) => READONLY_TOOL_POLICIES[tool](input).action;
  expect(action("bash", {})).toBe("block");
  expect(action("pstack_loop", { action: "arm", prompt: "x" })).toBe("block");
  expect(action("pstack_loop", {})).toBe("block");
  expect(action("pstack_loop", { action: "status" })).toBe("allow");
  expect(action("pstack_loop", { action: "list" })).toBe("allow");
  expect(action("pstack_loop", { action: "stop" })).toBe("allow");
  expect(action("pstack_decision_log", { phase: "x" })).toBe("block");
  expect(action("pstack_benny_wake", { action: "append" })).toBe("block");
  expect(action("pstack_benny_wake", { action: "drain" })).toBe("block");
  expect(action("pstack_benny_wake", { action: "path" })).toBe("allow");
  expect(action("pstack_swarm", { workers: [] })).toBe("block");
  expect(action("pstack_arena", { prompt: "x", candidates: [] })).toBe("block");
  expect(action("pstack_control_cli", { argv: ["git", "status"] })).toBe("block");
  expect(action("pstack_spawn", { task: "x" })).toBe("coerceReadonly");
  expect(action("pstack_spawn", { task: "x", readonly: true })).toBe("allow");
  expect(action("pstack_spawn", { task: "x", role: "investigator" })).toBe("allow");
  expect(action("pstack_sessions", { action: "list" })).toBe("allow");
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
  expect(tools.length >= 14, `expected the pstack tool surface, found ${tools.length}`).toBeTruthy();
  for (const tool of tools) {
    expect(tool in READONLY_TOOL_POLICIES, `${tool} has no readonly policy`).toBeTruthy();
  }
});
