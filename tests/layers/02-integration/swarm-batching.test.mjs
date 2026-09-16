import { expect, test } from "vitest";
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
  expect(tool, "registerSwarm must register a tool").toBeTruthy();
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
  expect(Check(tool.parameters, twelveWorkers), "12 workers must pass the schema").toBe(true);
  const tooMany = {
    workers: Array.from({ length: MAX_SWARM_WORKERS + 1 }, (_value, index) => ({ task: `worker ${index + 1}` })),
  };
  expect(Check(tool.parameters, tooMany), "the schema still bounds a single call").toBe(false);
});

test("swarm-batch-02 runs every over-cap worker in sequential waves without exceeding the cap", async () => {
  const workerCount = MAX_CONCURRENCY * 2 + 3;
  const items = Array.from({ length: workerCount }, (_value, index) => ({ index, delayMs: (index % 4) + 1 }));
  const tracker = concurrencyTracker();

  const results = await runInWaves(items, MAX_CONCURRENCY, tracker.run);
  const state = tracker.state();

  expect(results.length, "every worker ran").toBe(workerCount);
  expect(results, "input order is preserved").toEqual(items.map((item) => item.index));
  expect(state.seen.length, "no worker ran twice").toBe(workerCount);
  expect(state.peak, `peak concurrency ${state.peak} must equal the cap`).toBe(MAX_CONCURRENCY);
  expect(state.waveStarts, "each wave must finish before the next starts").toBe(Math.ceil(workerCount / MAX_CONCURRENCY));
});

test("swarm-batch-03 a single wave keeps the pre-batching behavior for N at or below the cap", async () => {
  const items = Array.from({ length: MAX_CONCURRENCY }, (_value, index) => ({ index, delayMs: 1 }));
  const tracker = concurrencyTracker();
  const results = await runInWaves(items, MAX_CONCURRENCY, tracker.run);
  expect(results).toEqual(items.map((item) => item.index));
  expect(tracker.state().waveStarts, "N <= cap is one wave").toBe(1);
  expect(tracker.state().peak).toBe(MAX_CONCURRENCY);
});
