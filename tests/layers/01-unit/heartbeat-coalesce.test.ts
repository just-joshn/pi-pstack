import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(result.action, "coalesce");
});

test("decideFire returns fire after window", () => {
  const state = { lastFireAt: 1000, fires: 0, maxFires: 10, armed: true };
  const now = 1000 + DYNAMIC_COALESCE_MS + 100;
  const result = decideFire(state, "test", now);
  assert.equal(result.action, "fire");
  assert.equal(result.fires, 1);
  assert.equal(result.reason, "test");
});

test("decideFire returns stop when maxFires exceeded", () => {
  const state = { lastFireAt: 1000, fires: 10, maxFires: 10, armed: true };
  const now = 5000;
  const result = decideFire(state, "test", now);
  assert.equal(result.action, "stop");
  assert.equal(result.fires, 11);
});

test("decideFire returns coalesce when not armed", () => {
  const state = { lastFireAt: 1000, fires: 0, maxFires: 10, armed: false };
  const now = 5000;
  const result = decideFire(state, "test", now);
  assert.equal(result.action, "coalesce");
});

test("shouldSkipSettleArm returns true within window", () => {
  const lastFireAt = 1000;
  const now = 1000 + DYNAMIC_COALESCE_MS - 100;
  const result = shouldSkipSettleArm(lastFireAt, now);
  assert.equal(result, true);
});

test("shouldSkipSettleArm returns false after window", () => {
  const lastFireAt = 1000;
  const now = 1000 + DYNAMIC_COALESCE_MS + 100;
  const result = shouldSkipSettleArm(lastFireAt, now);
  assert.equal(result, false);
});

test("materializeWatchArgv for watch-pr-status", () => {
  const result = materializeWatchArgv("watch-pr-status", "123");
  assert.deepEqual(result, [
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--pr",
    "123",
    "--status-only",
  ]);
});

test("materializeWatchArgv for watch-pr-drive", () => {
  const result = materializeWatchArgv("watch-pr-drive", "#456");
  assert.deepEqual(result, [
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--pr",
    "456",
  ]);
});

test("no babysit recipe executes the bundled watcher through bash", () => {
  for (const [recipeId, recipe] of Object.entries(BABYSIT_WATCH_RECIPES)) {
    assert.equal(recipe.argvTemplate.includes("bash"), false, `${recipeId} must not use bash`);
  }
});

test("materializeWatchArgv for watch-pr-queued-stack threads the frozen stack", () => {
  const result = materializeWatchArgv("watch-pr-queued-stack", "7", { stackPrs: ["3", "5", "7"] });
  assert.deepEqual(result, [
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--queued-stack",
    "--stack-prs",
    "3,5,7",
  ]);
  assert.throws(() => materializeWatchArgv("watch-pr-queued-stack", "7"), /stackPrs/);
});

test("watchPrInvocation runs the watcher with bun and its path", () => {
  assert.deepEqual(watchPrInvocation("/abs/watch-pr", ["--pr", "9"]), {
    command: "bun",
    args: ["/abs/watch-pr", "--pr", "9"],
  });
});

test("assertBunAvailable names the missing runtime instead of a bare ENOENT", async () => {
  await assertBunAvailable(async () => ({ code: 0 }));
  await assert.rejects(
    () => assertBunAvailable(async () => ({ code: 1 })),
    /bun is required.*not found on PATH/,
  );
});

test("materializeWatchArgv throws on unknown recipe", () => {
  assert.throws(() => materializeWatchArgv("unknown", "123"), /unknown babysit watch recipe/);
});

test("materializeWatchArgv throws on invalid pr", () => {
  assert.throws(() => materializeWatchArgv("watch-pr-status", ""), /invalid pr for watchArgv/);
  assert.throws(() => materializeWatchArgv("watch-pr-status", "-123"), /invalid pr for watchArgv/);
  assert.throws(() => materializeWatchArgv("watch-pr-status", "12 3"), /invalid pr for watchArgv/);
});
