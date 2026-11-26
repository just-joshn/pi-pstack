import assert from "node:assert/strict";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import { startPlan, updateTask } from "../src/lib/state.ts";
import { planCall, planChecklist, planResult } from "../src/plan-view.ts";
import { host } from "./host.ts";
import { shaped } from "./support.ts";

const theme = shaped<Theme>({ fg: (color: string, text: string) => `<${color}>${text}` });
const drawn = (plan: unknown) =>
  planChecklist(plan, theme)
    .render(200)
    .map((l) => l.trimEnd());

test("the checklist shows each task's state and the plan's progress", () => {
  let plan = startPlan("figure-it-out", "ship", ["one", "two", "three", "four", "five"]);
  plan = updateTask(plan, 1, "done", "proof");
  plan = updateTask(plan, 2, "active");
  plan = updateTask(plan, 3, "blocked", "waiting");
  plan = updateTask(plan, 4, "skipped", "not needed");
  assert.deepEqual(drawn(plan), [
    "<toolTitle>figure-it-out 2/5",
    "<success>[x] 1. one",
    "<accent>[>] 2. two",
    "<error>[!] 3. three",
    "<dim>[-] 4. four",
    "<muted>[ ] 5. five",
  ]);
  assert.equal(drawn({ ...plan, finishedEvidence: "all green" }).at(-1), "<success>Finished");
  assert.deepEqual(drawn(null), ["<muted>No plan"]);
  assert.deepEqual(drawn(undefined), ["<muted>No plan"], "older results carry no plan");
});

test("pstack_plan returns the plan it changed for the conversation to draw", async () => {
  const h = host();
  const started = await h.call("pstack_plan", { action: "custom", goal: "g", steps: ["a", "b"] });
  assert.equal(shaped<{ details: { tasks: unknown[] } }>(started).details.tasks.length, 2);
  const shown = await h.call("pstack_plan", { action: "show" });
  assert.deepEqual(
    shaped<{ details: unknown }>(shown).details,
    shaped<{ details: unknown }>(started).details,
  );
});

const line = (args: Parameters<typeof planCall>[0]) =>
  planCall(args, theme).render(200)[0]?.trimEnd();

test("the call header names the change in one line", () => {
  assert.equal(
    line({ action: "update", task: 2, status: "done" }),
    "<toolTitle>pstack_plan update <dim>2 → done",
  );
  assert.equal(line({ action: "update" }), "<toolTitle>pstack_plan update <dim>? → ?");
  assert.equal(
    line({ action: "start", route: "bug-fix", goal: "parser" }),
    "<toolTitle>pstack_plan start <dim>bug-fix: parser",
  );
  assert.equal(line({ action: "show" }), "<toolTitle>pstack_plan show");
});

test("a failed plan change shows its error, not an empty plan", () => {
  const failed = { content: [{ type: "text" as const, text: "Unknown task" }], details: undefined };
  const lines = planResult(failed, true, theme)
    .render(200)
    .map((l) => l.trimEnd());
  assert.deepEqual(lines, ["<error>Unknown task"]);
  const plan = startPlan("figure-it-out", "g", ["a"]);
  const shown = planResult({ content: [], details: plan }, false, theme).render(200);
  assert.equal(shown[0]?.trimEnd(), "<toolTitle>figure-it-out 0/1");
});
