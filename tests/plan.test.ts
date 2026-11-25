import assert from "node:assert/strict";

import { describe, onTestFinished, test, vi } from "vitest";

import { routes } from "../lib/catalog.ts";
import type { Wake } from "../lib/state.ts";
import { host, type Summary } from "./host.ts";
import { nth, shaped } from "./support.ts";

const custom = { action: "custom", goal: "verify", steps: ["check"] };

describe("plan commands", () => {
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
    assert.equal(status.plan?.goal, "repair the pool");
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
    await h.call("pstack_plan", custom);
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
});
