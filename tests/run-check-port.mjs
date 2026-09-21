#!/usr/bin/env node
/**
 * Run the native check-port gate over the published package files only.
 * Agent notes under .pi/, the old port cache, and worktree scratch dirs stay out.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "skills/poteto-mode/scripts/check-port.mjs");
const ENTRIES = [
  "extensions",
  "skills",
  "agents",
  "docs",
  "automations",
  "assets",
  "README.md",
  "LICENSE",
  "NOTICE",
  "package.json",
];

const tmp = mkdtempSync(join(tmpdir(), "pstack-check-port-"));
try {
  for (const name of ENTRIES) {
    const src = join(ROOT, name);
    if (!existsSync(src)) continue;
    symlinkSync(src, join(tmp, name));
  }
  const result = spawnSync(process.execPath, [CHECKER, tmp], { encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
