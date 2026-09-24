import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("runner main runs when launched through a symlinked directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pa-link-"));
  const link = path.join(dir, "linked");
  symlinkSync(import.meta.dir, link);
  const result = spawnSync("node", [path.join(link, "runner.mjs"), dir, path.join(dir, "missing.json")], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  expect(result.stderr).toContain("Invalid pstack-agents runner request");
  expect(result.status).toBe(1);
});
