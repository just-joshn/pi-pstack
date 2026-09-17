import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRoleModel } from "../../../extensions/models/config.ts";

test("resolveRoleModel reads the project model config when given a cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-models-"));
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = join(dir, "home");
    mkdirSync(process.env.HOME, { recursive: true });
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "pstack-models.json"),
      JSON.stringify({ version: 1, roles: { "swarm workers": "anthropic/claude-sonnet-4-5" } }),
    );
    expect(resolveRoleModel("swarm workers", "xai/grok-4", 0, dir), "the project config must win over the parent model").toBe("anthropic/claude-sonnet-4-5");
    expect(resolveRoleModel("swarm workers", "xai/grok-4"), "without a cwd the project config is invisible").toBe(undefined);
  } finally {
    if (savedHome === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
