import { expect, test } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../../support/repo-root.mjs";

const ROOT = repoRoot(import.meta.url);

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
    expect((mode & 0o111) !== 0, `${rel} must be executable for direct invocation`).toBeTruthy();
  }
});

test("package.json declares the bun runtime the ported scripts need", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  const range = pkg.engines?.bun;
  expect(typeof range, "engines.bun must be declared").toBe("string");
  expect(range.length > 0, "engines.bun must name a version range").toBeTruthy();
});
