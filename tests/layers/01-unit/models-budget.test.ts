import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRoleModel } from "../../../extensions/models/config.ts";
import { effortForBudget, withBudget } from "../../../extensions/models/budget.ts";

function withConfig(budget: unknown, roleValue: string, run: (cwd: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pstack-budget-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "pstack-models.json"),
      JSON.stringify({ version: 1, budget, roles: { "swarm workers": roleValue } }),
    );
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("models-09 maps each budget label to a Pi thinking level", () => {
  const cases = [
    ["unlimited — keep max", "max"],
    ["large — xhigh reasoning", "xhigh"],
    ["medium — high reasoning", "high"],
    ["small — medium reasoning", "medium"],
  ] as const;
  for (const [label, level] of cases) {
    withConfig(label, "anthropic/claude-opus-4-5", (cwd) => {
      expect(resolveRoleModel("swarm workers", "xai/grok-4", 0, cwd), `${label} must reach the child selector`).toBe(`anthropic/claude-opus-4-5:${level}`);
    });
  }
});

test("models-09 an explicit effort token wins over the budget", () => {
  withConfig("small — medium reasoning", "anthropic/claude-opus-4-5-xhigh", (cwd) => {
    expect(resolveRoleModel("swarm workers", "xai/grok-4", 0, cwd), "the effort written for the role must survive the budget").toBe("anthropic/claude-opus-4-5:xhigh");
  });
});

test("models-09 inherit-parent roles carry the budget to the parent model", () => {
  withConfig("small — medium reasoning", "inherit-parent", (cwd) => {
    expect(resolveRoleModel("swarm workers", "deepseek-flash", 0, cwd), "an inheriting child still receives the configured level").toBe("deepseek-flash:medium");
  });
});

test("models-09 an unknown budget and a missing budget leave the selector unchanged", () => {
  withConfig("wild", "anthropic/claude-opus-4-5", (cwd) => {
    expect(resolveRoleModel("swarm workers", "xai/grok-4", 0, cwd), "an unknown budget must not invent a level").toBe("anthropic/claude-opus-4-5");
  });
  expect(effortForBudget(undefined), "a missing budget has no effort target").toBe(null);
  expect(effortForBudget("unlimited (max)"), "the written default label parses").toBe("max");
  expect(withBudget("xai/grok-4", null), "a null budget leaves the selector alone").toBe("xai/grok-4");
});
