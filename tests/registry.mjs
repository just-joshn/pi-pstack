import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export const LAYERS = [
  { id: 1, name: "unit", dir: "tests/layers/01-unit", runner: "node-test" },
  { id: 2, name: "integration", dir: "tests/layers/02-integration", runner: "node-test" },
  { id: 3, name: "smoke", dir: "tests/layers/03-smoke", runner: "node-test", requires: ["pi"] },
  { id: 4, name: "reload", dir: "tests/layers/04-reload", runner: "node-test", requires: ["pi", "tmux"] },
  { id: 5, name: "rpc", dir: "tests/layers/05-rpc", runner: "node-test", requires: ["pi"] },
  { id: 6, name: "tui", dir: "tests/layers/06-tui", runner: "node-test", requires: ["pi", "tmux"] },
  { id: 7, name: "third-party", dir: "tests/layers/07-third-party", runner: "node-test", optIn: true, timeoutMs: 900000 },
  {
    id: "legacy",
    name: "legacy",
    runner: "commands",
    commands: [
      ["npm", ["run", "test:extensions"], "."],
      ["bun", ["test"], "skills/poteto-mode/scripts"],
    ],
  },
];

export function layerFiles(layer, repoRoot) {
  if (layer.runner === "commands") return [];

  const dir = join(repoRoot, layer.dir);
  if (!existsSync(dir)) return [];

  function walk(path) {
    let entries = [];
    for (const entry of readdirSync(path)) {
      const fullPath = join(path, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        entries = [...entries, ...walk(fullPath)];
      } else if (/\.test\.(mjs|ts)$/.test(entry)) {
        entries = [...entries, fullPath];
      }
    }
    return entries;
  }

  return walk(dir).toSorted();
}

export function resolveLayers(selector) {
  if (selector === "all") {
    return LAYERS;
  }

  if (selector === "legacy") {
    return [LAYERS.find((l) => l.id === "legacy")];
  }

  const trimmed = String(selector).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Unknown layer selector: ${selector}`);
  }

  const num = parseInt(trimmed, 10);
  const layer = LAYERS.find((l) => l.id === num);
  if (!layer) {
    throw new Error(`Unknown layer selector: ${selector}`);
  }

  return [layer];
}
