import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../../support/repo-root.mjs";
import { integrationEntries } from "../../../extensions/integrations/registry.ts";

const ROOT = repoRoot(import.meta.url);
const WHY_SKILL = readFileSync(resolve(ROOT, "skills/why/SKILL.md"), "utf8");

test("why discovery uses the integration registry and reports coverage gaps", () => {
  assert.equal(
    WHY_SKILL.includes("run `pstack_integrations` with `action: status`"),
    true,
    "the discovery step names the registry tool",
  );
  assert.equal(
    WHY_SKILL.includes("report it as a null finding naming its missing prerequisite"),
    true,
    "an unavailable category is a named coverage gap",
  );
  assert.equal(
    WHY_SKILL.includes("never skip it and never substitute another capability"),
    true,
    "the skill forbids skipping a category or substituting another",
  );
  assert.equal(
    WHY_SKILL.includes("list the MCP servers available in this Pi session"),
    false,
    "the superseded live-tool-list wording is gone",
  );
});

test("why and reflect investigators keep integrations with a read-only filesystem", () => {
  const occurrences = WHY_SKILL.split("filesystem `read-only`, integrations `inherit`").length - 1;
  assert.equal(occurrences, 2, "both the investigator and synthesizer stanzas state the policy");
  assert.equal(
    WHY_SKILL.includes("readonly and integrations are not the same axis"),
    true,
    "the skill explains why the two axes are independent",
  );
});

test("the registry covers the seven why evidence categories", () => {
  const ids = integrationEntries().map((entry) => entry.id);
  assert.deepEqual(ids, [
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
  assert.equal(evidence.length, 7);
  assert.equal(WHY_SKILL.includes("Product analytics warehouse"), true, "the seventh category stays in the skill");
});
