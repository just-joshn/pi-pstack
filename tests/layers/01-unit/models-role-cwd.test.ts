import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRoleModel } from "../../../extensions/models/config.ts";

test("resolveRoleModel reads the project model config when given a cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-models-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "pstack-models.json"),
      JSON.stringify({ version: 1, roles: { "swarm workers": "anthropic/claude-sonnet-4-5" } }),
    );
    assert.equal(
      resolveRoleModel("swarm workers", "xai/grok-4", 0, dir),
      "anthropic/claude-sonnet-4-5",
      "the project config must win over the parent model",
    );
    assert.equal(
      resolveRoleModel("swarm workers", "xai/grok-4"),
      undefined,
      "without a cwd the project config is invisible",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
