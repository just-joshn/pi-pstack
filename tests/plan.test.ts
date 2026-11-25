import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { onTestFinished, test, vi } from "vitest";

import { routes } from "../src/lib/catalog.ts";
import type { Wake } from "../src/lib/state.ts";
import { isRecord } from "../src/lib/validation.ts";
import { host, planned, readResult, type Summary, type ToolResponse } from "./host.ts";
import { nth, shaped } from "./support.ts";

const woke = (response: ToolResponse) => shaped<Wake>(readResult(response));
function systemPrompt(started: unknown) {
  const prompt = isRecord(started) ? started["systemPrompt"] : undefined;
  assert(typeof prompt === "string");
  return prompt;
}
async function finishedPlan() {
  const h = host();
  await h.call("pstack_plan", { action: "custom", goal: "verify", steps: ["check"] });
  await h.call("pstack_plan", { action: "update", task: 1, status: "done", evidence: "passed" });
  const done = planned(await h.call("pstack_plan", { action: "finish", evidence: "green" }));
  return { h, done };
}

test("/poteto-mode with a goal runs the router once without saving the mode", async () => {
  const h = host();
  await h.cmd("poteto-mode", " fix the flaky smoke test ");
  const prompt = nth(h.messages, 0);
  assert.match(prompt, /^Execute the Pi-native workflow poteto-mode /);
  assert.match(prompt, /\nOperator request:\nfix the flaky smoke test$/);
  assert.equal(h.entries.length, 0);
});

test("/poteto-mode off turns a saved mode back off and sends nothing", async () => {
  const h = host();
  await h.cmd("poteto-mode", "on");
  assert.equal(h.state().mode, true);
  await h.cmd("poteto-mode", "off");
  assert.equal(h.state().mode, false);
  assert.equal(h.messages.length, 0);
});

test("/poteto-mode without a goal asks for one and sends nothing when the prompt is dismissed", async () => {
  const h = host();
  const prompts: string[] = [];
  let answer: string | undefined = "ship the fix; done when CI is green";
  h.ctx.ui.input = async (title) => {
    prompts.push(title);
    return answer;
  };
  await h.cmd("poteto-mode");
  answer = undefined;
  await h.cmd("poteto-mode");
  assert.deepEqual(prompts, Array(2).fill("Goal and observable completion predicate"));
  assert.equal(h.messages.length, 1);
  assert.match(nth(h.messages, 0), /\nOperator request:\nship the fix; done when CI is green$/);
});

test("/poteto-mode without a goal explains its usage where there is no UI", async () => {
  const h = host({ mode: "print" });
  h.ctx.ui.input = () => assert.fail("There is no prompt without a UI");
  await h.cmd("poteto-mode");
  assert.deepEqual(h.messages, ["Use /poteto-mode on or /poteto-mode <goal>."]);
});

test("/pstack-run lists the routes instead of starting an unknown route or an empty goal", async () => {
  const h = host();
  await h.cmd("pstack-run");
  await h.cmd("pstack-run", "bug-fix");
  await h.cmd("pstack-run", "no-such-route repair the pool");
  assert.deepEqual(
    h.notifications,
    Array(3).fill(`Choose a route and goal:\n${routes.join(", ")}`),
  );
  assert.equal(h.entries.length, 0);
  assert.equal(h.messages.length, 0);
});

test("/pstack-status shows the goal, the plan and the loop", async () => {
  const h = host();
  await h.cmd("pstack-goal", "ship 0.2");
  await h.cmd("pstack-run", "bug-fix repair the pool");
  await h.cmd("pstack-status");
  const status = shaped<Summary>(JSON.parse(nth(h.notifications, 0)));
  assert.equal(status.goal, "ship 0.2");
  assert.equal(status.plan?.route, "bug-fix");
  assert.equal(status.plan.goal, "repair the pool");
  assert.equal(status.wake, null);
  assert.equal(status.complete, false);
});

test("/pstack-goal shows, replaces and clears the branch goal", async () => {
  const h = host();
  await h.cmd("pstack-goal");
  await h.cmd("pstack-goal", " ship 0.2 ");
  await h.cmd("pstack-goal");
  await h.cmd("pstack-goal", "clear");
  await h.cmd("pstack-goal");
  assert.deepEqual(h.notifications, ["No goal", "ship 0.2", "No goal"]);
  assert.equal(h.state().goal, "");
});

test("/pstack-loop without arguments shows the loop, and stop halts it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const h = host({ confirm: true });
  const shownLoop = () => shaped<Wake | null>(JSON.parse(h.notifications.at(-1) ?? ""));
  await h.cmd("pstack-loop");
  assert.equal(shownLoop(), null);
  await h.cmd("pstack-loop", "5 2 green");
  await h.cmd("pstack-loop");
  assert.deepEqual(shownLoop(), {
    seconds: 5,
    max: 2,
    predicate: "green",
    count: 0,
    running: true,
  });
  await h.cmd("pstack-loop", "stop");
  await h.cmd("pstack-loop");
  assert.equal(shownLoop()?.running, false);
  vi.advanceTimersByTime(5000);
  assert.equal(h.messages.length, 0);
});

test("a plan update names both a task and a known status", async () => {
  const h = host();
  await h.call("pstack_plan", { action: "custom", goal: "verify", steps: ["check"] });
  const update = (change: object) => h.call("pstack_plan", { action: "update", ...change });
  await assert.rejects(() => update({ status: "done", evidence: "x" }), /task and status/);
  await assert.rejects(() => update({ task: 1 }), /task and status/);
  await assert.rejects(() => update({ task: 1, status: "finished" }), /task and status/);
  assert.equal(h.state().plan?.tasks[0]?.status, "pending");
});

test("the plan tool starts nothing without a goal", async () => {
  const h = host();
  await assert.rejects(
    () => h.call("pstack_plan", { action: "start", route: "bug-fix" }),
    /goal is required/,
  );
  await assert.rejects(
    () => h.call("pstack_plan", { action: "custom", steps: ["check"] }),
    /goal is required/,
  );
  assert.equal(h.entries.length, 0);
});

test("command activation, explicit plan, native tool update and restore", async () => {
  const h = host();
  await h.cmd("poteto-mode", "on");
  assert.equal(h.state().mode, true);
  const prompt = systemPrompt(h.emit("before_agent_start", { systemPrompt: "base" }));
  assert.match(prompt, /Persistent poteto-mode\. File: \/.+\/skills\/poteto-mode\/SKILL\.md\n/);
  assert.match(prompt, /Relative paths in it resolve from \/.+\/skills\/poteto-mode\./);
  assert(prompt.includes("## Subagents"));
  await h.cmd("pstack-run", "bug-fix repair");
  assert(h.messages.at(-1)?.includes("### Bug fix"));
  assert.equal(h.state().plan?.route, "bug-fix");
  await h.call("pstack_plan", {
    action: "update",
    task: 1,
    status: "done",
    evidence: "red test",
  });
  assert.equal(h.state().plan?.tasks[0]?.status, "done");
  await assert.rejects(() => h.call("pstack_plan", { action: "finish", evidence: "not enough" }));
  h.emit("session_tree");
  assert.equal(h.state().plan?.tasks[0]?.evidence, "red test");
  await h.cmd("pstack-clear");
  assert.equal(h.state().plan, null);
});

test("timer does not start without confirmation, is cancelled on shutdown and denied headless", async () => {
  const h = host();
  await h.cmd("pstack-loop", "5 2 done");
  assert.equal(h.entries.length, 0);
  const yes = host({ confirm: true });
  await yes.cmd("pstack-loop", "5 2 done");
  assert.equal(yes.state().wake?.running, true);
  await yes.cmd("pstack-loop", "stop");
  assert.equal(yes.state().wake?.running, false);
  yes.emit("session_shutdown");
  const headless = host({ mode: "print" });
  await assert.rejects(() => headless.cmd("pstack-loop", "5 2 done"));
});

for (const mode of ["print", "json"] as const)
  test(`${mode} mode rejects writes, merges, and worktree removal before executing shell`, async () => {
    const h = host({ mode, confirm: true });
    await h.cmd("pstack-run", "shipping Merge reviewed PR");
    await assert.rejects(
      () => h.call("pstack_delegate", { mode: "single", tasks: ["write"], readOnly: false }),
      /Write delegation not authorized/,
    );
    await assert.rejects(
      () =>
        h.call("pstack_ship", {
          proofs: [{ number: 1, head: "a".repeat(40), evidence: "proof", independent: true }],
        }),
      /interactive approval/,
    );
    await assert.rejects(
      () => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
      /Removal not authorized/,
    );
    assert.equal(h.executions.length, 0);
  });

test("a restored or completed wake loop cannot enqueue another turn", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const h = host({ confirm: true });
  await h.cmd("pstack-loop", "5 1 green");
  h.emit("session_tree");
  vi.advanceTimersByTime(5000);
  assert.equal(h.messages.length, 0);
  await h.cmd("pstack-loop", "5 1 green");
  vi.advanceTimersByTime(5000);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0] ?? "", /Wake 1\/1/);
  h.emit("agent_settled", { aborted: false });
  vi.advanceTimersByTime(5000);
  assert.equal(h.messages.length, 1);
  assert.equal(woke(await h.call("pstack_wake", { action: "show" })).running, false);
});

test("the plan tool accepts custom steps only through the custom action", async () => {
  const h = host();
  await assert.rejects(
    () =>
      h.call("pstack_plan", {
        action: "start",
        route: "figure-it-out",
        goal: "verify",
        steps: ["check"],
      }),
    /known playbook/,
  );
  assert.equal(h.entries.length, 0);
  const made = planned(
    await h.call("pstack_plan", { action: "custom", goal: "verify", steps: ["check"] }),
  );
  assert.equal(made.complete, false);
});

test("a finished plan records its evidence and leaves the system prompt alone", async () => {
  const { h, done } = await finishedPlan();
  assert.equal(done.plan?.finishedEvidence, "green");
  assert.equal(h.emit("before_agent_start", { systemPrompt: "base" }), undefined);
});

test("Team Kit rules are appended to the system prompt only while poteto-mode is on", async () => {
  const h = host();
  assert.equal(h.emit("before_agent_start", { systemPrompt: "base" }), undefined);
  await h.cmd("poteto-mode", "on");
  const prompt = systemPrompt(h.emit("before_agent_start", { systemPrompt: "base" }));
  assert(prompt.startsWith("base\n\n"));
  assert.match(prompt, /# No inline imports/);
  assert.match(prompt, /# Exhaustive TypeScript switches/);
});

test("clearing state keeps the resume note written by a pause", async () => {
  const { h } = await finishedPlan();
  await h.cmd("pstack-goal", "keep progress");
  await h.cmd("pstack-pause");
  const history = shaped<{ entries: unknown[]; artifacts: string }>(
    readResult(await h.call("pstack_history", { limit: 1 })),
  );
  assert.equal(history.entries.length, 1);
  const path = join(history.artifacts, "resume.json");
  const resumeGoal = async () =>
    shaped<{ goal: string }>(JSON.parse(await readFile(path, "utf8"))).goal;
  assert.equal(await resumeGoal(), "keep progress");
  await h.cmd("pstack-clear");
  const shown = shaped<Summary>(readResult(await h.call("pstack_plan", { action: "show" })));
  assert.equal(shown.plan, null);
  assert.equal(await resumeGoal(), "keep progress");
});

test("the agent cannot select a merge-capable route without operator approval", async () => {
  const start = { action: "start", route: "shipping", goal: "Merge reviewed PR" };
  for (const h of [host({ confirm: false }), host({ mode: "print", confirm: true })]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The hosts are independent; a plain loop is simpler than Promise.all.
    await assert.rejects(() => h.call("pstack_plan", start), /operator approval/);
    assert.equal(h.entries.length, 0);
  }
  const approved = host({ confirm: true });
  const made = planned(await approved.call("pstack_plan", start));
  assert.equal(made.plan?.route, "shipping");
  const other = host({ confirm: () => assert.fail("Other routes need no approval") });
  await other.call("pstack_plan", { action: "start", route: "bug-fix", goal: "repair" });
});

test("stopping a wake loop records why it stopped", async () => {
  const h = host({ confirm: true });
  await h.cmd("pstack-loop", "5 2 green");
  await assert.rejects(() => h.call("pstack_wake", { action: "stop", evidence: " " }), /evidence/);
  const stopped = woke(
    await h.call("pstack_wake", { action: "stop", evidence: "CI green on abc123" }),
  );
  assert.equal(stopped.running, false);
  assert.equal(stopped.stopEvidence, "CI green on abc123");
  assert.equal(h.state().wake?.stopEvidence, "CI green on abc123");
  await h.cmd("pstack-loop", "5 2 green");
  assert.equal(h.state().wake?.running, true);
  assert.equal(h.state().wake?.stopEvidence, undefined);
  h.emit("session_shutdown");
});

test("the agent arms the wake loop itself, as upstream arms /loop, and only in an open session", async () => {
  const h = host();
  await h.call("pstack_wake", { action: "start", seconds: 3600, max: 24, predicate: "CI green" });
  assert.deepEqual(h.state().wake, {
    seconds: 3600,
    max: 24,
    predicate: "CI green",
    count: 0,
    running: true,
  });
  await assert.rejects(
    () => h.call("pstack_wake", { action: "start", seconds: 1, max: 1, predicate: "x" }),
    /5–86400 seconds/,
  );
  await h.call("pstack_wake", { action: "stop", evidence: "CI green at abc123" });
  assert.equal(h.state().wake?.running, false);
  const headless = host({ mode: "print" });
  await assert.rejects(
    () => headless.call("pstack_wake", { action: "start", seconds: 60, max: 1, predicate: "x" }),
    /open interactive Pi session/,
  );
});

test("a playbook step adds tasks to the open plan, as upstream adds todo items", async () => {
  const h = host();
  await h.call("pstack_plan", { action: "start", route: "feature", goal: "ship it" });
  const before = h.state().plan?.tasks.length ?? 0;
  const checkpoint = ["Blocking first steps", "Independent workstreams"];
  await h.call("pstack_plan", { action: "add", steps: checkpoint });
  const tasks = h.state().plan?.tasks ?? [];
  assert.deepEqual(
    tasks.slice(before).map(({ id, text, status }) => ({ id, text, status })),
    checkpoint.map((text, i) => ({ id: before + i + 1, text, status: "pending" })),
  );
  await assert.rejects(() => h.call("pstack_plan", { action: "add", steps: [] }), /Supply/);
  await assert.rejects(
    () => host().call("pstack_plan", { action: "add", steps: ["x"] }),
    /No active plan/,
  );
});
