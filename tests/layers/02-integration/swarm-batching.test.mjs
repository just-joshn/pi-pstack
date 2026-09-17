import { expect, test } from "vitest";
import { Check } from "typebox/value";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SWARM_WORKERS, registerSwarm, runInWaves } from "../../../extensions/orchestration/swarm.ts";
import { MAX_CONCURRENCY } from "../../../extensions/subagents/child-runner.ts";
import { withSession } from "../../support/session.mjs";
import { installChildScript, writeStubChild } from "../../support/pi-host.mjs";

const SWARM_STUB_SOURCE = [
  'const prompt = process.argv.at(-1) ?? "";',
  'const verdict = prompt.includes("VERDICT-ISSUES") ? "ISSUES" : "PASS";',
  'const text = "stub-swarm cwd=" + process.cwd() + "\\n" + verdict;',
  'const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };',
  'process.stdout.write(JSON.stringify(event) + "\\n");',
  "process.exitCode = 0;",
  "",
].join("\n");

function initRepo(cwd) {
  const identity = ["-c", "user.email=batch@example.test", "-c", "user.name=Batch"];
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", [...identity, "add", "-A"], { cwd });
  execFileSync("git", [...identity, "commit", "-q", "-m", "base"], { cwd });
}

async function withSwarmSession(run) {
  const root = mkdtempSync(join(tmpdir(), "pstack-swarm-batch-"));
  const restoreArgv = installChildScript(writeStubChild(root, SWARM_STUB_SOURCE));
  try {
    return await withSession(run, { initialFiles: { "app.ts": "export const one = 1;\n" } });
  } finally {
    restoreArgv();
    rmSync(root, { recursive: true, force: true });
  }
}

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

async function driveSwarm(f, workers, extras = {}) {
  const ctx = f.session._extensionRunner.createContext();
  const tool = f.tool("pstack_swarm").definition;
  let updates = [];
  const reply = await tool.execute(
    "swarm",
    { workers, ...extras },
    undefined,
    (update) => {
      updates = [...updates, update.content[0].text];
    },
    ctx,
  );
  return { reply, updates };
}

test("swarm-batch-04 an over-cap pstack_swarm completes every worker in isolated waves", async () => {
  await withSwarmSession(async (f) => {
    initRepo(f.tmp.cwd);
    const workerCount = MAX_CONCURRENCY + 1;
    const workers = Array.from({ length: workerCount }, (_value, index) => ({ task: `worker ${index + 1}` }));
    const { reply, updates } = await driveSwarm(f, workers);

    expect(reply.details.results.length, "every over-cap worker reports").toBe(workerCount);
    expect(updates.length, "one progress update per worker").toBe(workerCount);
    expect(updates.at(-1)).toBe(`${workerCount}/${workerCount} swarm workers done`);
    const cwds = new Set(reply.details.results.map((result) => result.cwd));
    expect(cwds.size, "each worker ran in its own worktree").toBe(workerCount);
    expect([...cwds].every((cwd) => cwd.includes(".pstack-worktrees")), "worktrees are pstack-managed").toBe(true);
    expect(reply.content[0].text).toContain("## Swarm report (coverage)");
    expect(reply.details.concurrencyCap).toBe(MAX_CONCURRENCY);
    expect(reply.details.verdicts).toEqual(Array.from({ length: workerCount }, () => "PASS"));
  });
});

test("swarm-batch-05 a mixed-verdict race names the declared winner through the tool", async () => {
  await withSwarmSession(async (f) => {
    initRepo(f.tmp.cwd);
    const { reply } = await driveSwarm(
      f,
      [{ task: "VERDICT-ISSUES candidate" }, { task: "clean candidate" }],
      { selection: "rank-all" },
    );
    expect(reply.details.selection).toBe("rank-all");
    expect(reply.details.verdicts).toEqual(["ISSUES", "PASS"]);
    expect(reply.details.winner, "PASS outranks ISSUES").toBe(1);
    expect(reply.content[0].text).toContain("Declared rule `rank-all`: take worker 2 (PASS).");
  });
});
