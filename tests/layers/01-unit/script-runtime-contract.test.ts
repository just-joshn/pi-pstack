import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const BUNDLED_SCRIPTS = [
  "skills/poteto-mode/scripts/watch-pr/watch-pr",
  "skills/poteto-mode/scripts/worktree-audit.sh",
  "skills/poteto-mode/scripts/check-plan.mjs",
  "skills/poteto-mode/scripts/orch/orch.ts",
  "skills/show-me-your-work/scripts/log.sh",
];

test("bundled scripts keep the executable bit upstream ships", () => {
  for (const rel of BUNDLED_SCRIPTS) {
    const mode = statSync(resolve(ROOT, rel)).mode;
    assert.ok((mode & 0o111) !== 0, `${rel} must be executable for direct invocation`);
  }
});

test("package.json declares the bun runtime the ported scripts need", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const range = pkg.engines?.bun;
  assert.equal(typeof range, "string", "engines.bun must be declared");
  assert.ok(range.length > 0, "engines.bun must name a version range");
});
