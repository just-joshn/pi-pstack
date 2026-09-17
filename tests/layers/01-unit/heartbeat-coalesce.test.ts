import { expect, test } from "vitest";
import {
  assertBunAvailable,
  decideFire,
  shouldSkipSettleArm,
  materializeWatchArgv,
  watchPrInvocation,
  BABYSIT_WATCH_RECIPES,
  DYNAMIC_COALESCE_MS,
} from "../../../extensions/heartbeat/coalesce.ts";

test("decideFire returns coalesce within window", () => {
  const state = { lastFireAt: 1000, fires: 0, maxFires: 10, armed: true };
  const now = 1000 + DYNAMIC_COALESCE_MS - 100;
  const result = decideFire(state, "test", now);
  expect(result.action).toBe("coalesce");
});

test("decideFire returns fire after window", () => {
  const state = { lastFireAt: 1000, fires: 0, maxFires: 10, armed: true };
  const now = 1000 + DYNAMIC_COALESCE_MS + 100;
  const result = decideFire(state, "test", now);
  expect(result.action).toBe("fire");
  expect(result.fires).toBe(1);
  expect(result.reason).toBe("test");
});

test("decideFire returns stop when maxFires exceeded", () => {
  const state = { lastFireAt: 1000, fires: 10, maxFires: 10, armed: true };
  const now = 5000;
  const result = decideFire(state, "test", now);
  expect(result.action).toBe("stop");
  expect(result.fires).toBe(11);
});

test("decideFire returns coalesce when not armed", () => {
  const state = { lastFireAt: 1000, fires: 0, maxFires: 10, armed: false };
  const now = 5000;
  const result = decideFire(state, "test", now);
  expect(result.action).toBe("coalesce");
});

test("shouldSkipSettleArm returns true within window", () => {
  const lastFireAt = 1000;
  const now = 1000 + DYNAMIC_COALESCE_MS - 100;
  const result = shouldSkipSettleArm(lastFireAt, now);
  expect(result).toBe(true);
});

test("shouldSkipSettleArm returns false after window", () => {
  const lastFireAt = 1000;
  const now = 1000 + DYNAMIC_COALESCE_MS + 100;
  const result = shouldSkipSettleArm(lastFireAt, now);
  expect(result).toBe(false);
});

test("materializeWatchArgv for watch-pr-status", () => {
  const result = materializeWatchArgv("watch-pr-status", "123");
  expect(result).toEqual([
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--pr",
    "123",
    "--status-only",
  ]);
});

test("materializeWatchArgv for watch-pr-drive", () => {
  const result = materializeWatchArgv("watch-pr-drive", "#456");
  expect(result).toEqual([
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--pr",
    "456",
  ]);
});

test("no babysit recipe executes the bundled watcher through bash", () => {
  for (const [recipeId, recipe] of Object.entries(BABYSIT_WATCH_RECIPES)) {
    expect(recipe.argvTemplate.includes("bash"), `${recipeId} must not use bash`).toBe(false);
  }
});

test("materializeWatchArgv for watch-pr-queued-stack threads the frozen stack", () => {
  const result = materializeWatchArgv("watch-pr-queued-stack", "7", { stackPrs: ["3", "5", "7"] });
  expect(result).toEqual([
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--queued-stack",
    "--stack-prs",
    "3,5,7",
  ]);
  expect(() => materializeWatchArgv("watch-pr-queued-stack", "7")).toThrow(/stackPrs/);
});

test("watchPrInvocation runs the watcher with bun and its path", () => {
  expect(watchPrInvocation("/abs/watch-pr", ["--pr", "9"])).toEqual({
    command: "bun",
    args: ["/abs/watch-pr", "--pr", "9"],
  });
});

test("assertBunAvailable names the missing runtime instead of a bare ENOENT", async () => {
  await assertBunAvailable(async () => ({ code: 0 }));
  await expect(() => assertBunAvailable(async () => ({ code: 1 }))).rejects.toThrow(/bun is required.*not found on PATH/);
});

test("materializeWatchArgv throws on unknown recipe", () => {
  expect(() => materializeWatchArgv("unknown", "123")).toThrow(/unknown babysit watch recipe/);
});

test("materializeWatchArgv throws on invalid pr", () => {
  expect(() => materializeWatchArgv("watch-pr-status", "")).toThrow(/invalid pr for watchArgv/);
  expect(() => materializeWatchArgv("watch-pr-status", "-123")).toThrow(/invalid pr for watchArgv/);
  expect(() => materializeWatchArgv("watch-pr-status", "12 3")).toThrow(/invalid pr for watchArgv/);
});
