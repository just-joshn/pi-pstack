import { test } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { MAX_SWARM_WORKERS, registerSwarm, runInWaves } from "../../../extensions/orchestration/swarm.ts";
import { MAX_CONCURRENCY } from "../../../extensions/subagents/child-runner.ts";

function captureSwarm() {
  let tool;
  const pi = {
    registerTool(definition) {
      tool = definition;
    },
  };
  registerSwarm(pi);
  assert.ok(tool, "registerSwarm must register a tool");
  return tool;
}

function concurrencyTracker() {
  let state = { active: 0, peak: 0, waveStarts: 0, seen: [] };
  return {
    run: async (item, index) => {
      const startsWave = state.active === 0;
      const active = state.active + 1;
      state = {
        active,
        peak: Math.max(state.peak, active),
        waveStarts: state.waveStarts + (startsWave ? 1 : 0),
        seen: [...state.seen, index],
      };
      await new Promise((resolve) => setTimeout(resolve, item.delayMs));
      state = { ...state, active: state.active - 1 };
      return index;
    },
    state: () => state,
  };
}

test("swarm-batch-01 accepts a request larger than the global concurrency cap", () => {
  const tool = captureSwarm();
  const twelveWorkers = {
    workers: Array.from({ length: 12 }, (_value, index) => ({ task: `worker ${index + 1}` })),
  };
  assert.equal(Check(tool.parameters, twelveWorkers), true, "12 workers must pass the schema");
  const tooMany = {
    workers: Array.from({ length: MAX_SWARM_WORKERS + 1 }, (_value, index) => ({ task: `worker ${index + 1}` })),
  };
  assert.equal(Check(tool.parameters, tooMany), false, "the schema still bounds a single call");
});

test("swarm-batch-02 runs every over-cap worker in sequential waves without exceeding the cap", async () => {
  const workerCount = MAX_CONCURRENCY * 2 + 3;
  const items = Array.from({ length: workerCount }, (_value, index) => ({ index, delayMs: (index % 4) + 1 }));
  const tracker = concurrencyTracker();

  const results = await runInWaves(items, MAX_CONCURRENCY, tracker.run);
  const state = tracker.state();

  assert.equal(results.length, workerCount, "every worker ran");
  assert.deepEqual(results, items.map((item) => item.index), "input order is preserved");
  assert.equal(state.seen.length, workerCount, "no worker ran twice");
  assert.equal(state.peak, MAX_CONCURRENCY, `peak concurrency ${state.peak} must equal the cap`);
  assert.equal(
    state.waveStarts,
    Math.ceil(workerCount / MAX_CONCURRENCY),
    "each wave must finish before the next starts",
  );
});

test("swarm-batch-03 a single wave keeps the pre-batching behavior for N at or below the cap", async () => {
  const items = Array.from({ length: MAX_CONCURRENCY }, (_value, index) => ({ index, delayMs: 1 }));
  const tracker = concurrencyTracker();
  const results = await runInWaves(items, MAX_CONCURRENCY, tracker.run);
  assert.deepEqual(results, items.map((item) => item.index));
  assert.equal(tracker.state().waveStarts, 1, "N <= cap is one wave");
  assert.equal(tracker.state().peak, MAX_CONCURRENCY);
});
