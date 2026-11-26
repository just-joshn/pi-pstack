import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { test } from "vitest";

import { srcDir } from "../src/lib/catalog.ts";

function markdown(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : markdown(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

/** The skills, playbooks, agents, references and guide, ported by hand from upstream pstack and Team Kit. */
const ported = ["skills", "agents", "docs"].flatMap((dir) => markdown(join(srcDir, dir)));

const cursorOnly = [
  /\.cursor\b/,
  /\.mdc\b/,
  /\bTask\b(?! list)/,
  /subagent_type/,
  /run_in_background/,
  /generalPurpose/,
  /cursor-team-kit/,
  /AskQuestion/,
  /-(?:xhigh|high|medium|low)-fast\b/,
  /\bCursor\b/,
];

test("the ported files name Pi mechanisms, not Cursor ones", () => {
  assert(ported.length > 100);
  for (const path of ported) {
    const text = readFileSync(path, "utf8");
    for (const pattern of cursorOnly)
      assert.doesNotMatch(text, pattern, `${relative(srcDir, path)} still says ${pattern}`);
  }
});
