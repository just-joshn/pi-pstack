import assert from "node:assert/strict";

import { describe, test } from "vitest";

import { slashSkills } from "../lib/catalog.ts";
import { host } from "./host.ts";

describe("extension", () => {
  test("mock host registers all 52 slash skills and 9 native tools", () => {
    const h = host();
    assert.equal(slashSkills.length, 52);
    for (const skill of slashSkills) assert(h.commands.has(skill.label.slice(1)), skill.id);
    assert.equal(h.tools.size, 9);
    assert(h.events.has("before_agent_start"));
    assert(h.events.has("session_shutdown"));
  });
});
