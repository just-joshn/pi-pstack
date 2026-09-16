import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../../support/repo-root.mjs";
import { integrationEntries } from "../../../extensions/integrations/registry.ts";

const ROOT = repoRoot(import.meta.url);
const WHY_SKILL = readFileSync(resolve(ROOT, "skills/why/SKILL.md"), "utf8");

test("why discovery uses the integration registry and reports coverage gaps", () => {
  expect(WHY_SKILL.includes("run `pstack_integrations` with `action: status`"), "the discovery step names the registry tool").toBe(true);
  expect(WHY_SKILL.includes("report it as a null finding naming its missing prerequisite"), "an unavailable category is a named coverage gap").toBe(true);
  expect(WHY_SKILL.includes("never skip it and never substitute another capability"), "the skill forbids skipping a category or substituting another").toBe(true);
  expect(WHY_SKILL.includes("list the MCP servers available in this Pi session"), "the superseded live-tool-list wording is gone").toBe(false);
});

test("why and reflect investigators keep integrations with a read-only filesystem", () => {
  const occurrences = WHY_SKILL.split("filesystem `read-only`, integrations `inherit`").length - 1;
  expect(occurrences, "both the investigator and synthesizer stanzas state the policy").toBe(2);
  expect(WHY_SKILL.includes("readonly and integrations are not the same axis"), "the skill explains why the two axes are independent").toBe(true);
});

test("the registry covers the seven why evidence categories", () => {
  const ids = integrationEntries().map((entry) => entry.id);
  expect(ids).toEqual([
    "source-control",
    "issue-tracker",
    "long-form-docs",
    "team-chat",
    "observability",
    "error-tracking",
    "analytics",
    "browser-ui",
    "cli-tui",
  ]);
  const evidence = [
    "source control history",
    "issue / ticket tracker",
    "long-form documents",
    "real-time team chat",
    "infrastructure observability",
    "error / exception tracking",
    "product analytics warehouse",
  ];
  expect(evidence.length).toBe(7);
  expect(WHY_SKILL.includes("Product analytics warehouse"), "the seventh category stays in the skill").toBe(true);
});
