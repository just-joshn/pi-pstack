/**
 * Vitest global setup: link the Pi peer packages into `node_modules/` and refuse
 * to start a layer whose external tools are missing. Both checks must fail before
 * a worker spawns, so a missing tool reports as an environment error rather than
 * as a pile of failed tests.
 */
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { ensurePeerLinks } from "./link-peers.mjs";
import { repoRoot } from "./repo-root.mjs";
import { layerByName } from "../registry.mjs";

const ROOT = repoRoot(import.meta.url);

function commandExists(cmd) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function requireTools(tools) {
  const missing = tools.filter((tool) => !commandExists(tool));
  if (missing.length > 0) {
    throw new Error(`missing required tool(s): ${missing.join(", ")}`);
  }
}

export function setup(project) {
  ensurePeerLinks(ROOT);
  const layer = layerByName(project.name);
  if (layer?.requires) requireTools(layer.requires);
}
