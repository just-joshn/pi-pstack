/**
 * Test layer manifest.
 *
 * One entry per suite. `vitest.config.ts` turns every non-opt-in `vitest` entry
 * into a project; `spec/spec-check.mjs` reads the same file to know which test
 * files a `test@` ledger row may reference. Layer 0 is a style gate, not a test
 * suite, so it stays a plain command.
 */
export const LAYERS = [
  { id: 0, name: "conformance", runner: "commands" },
  { id: 1, name: "unit", dir: "tests/layers/01-unit", runner: "vitest" },
  { id: 2, name: "integration", dir: "tests/layers/02-integration", runner: "vitest" },
  { id: 3, name: "smoke", dir: "tests/layers/03-smoke", runner: "vitest", requires: ["pi"] },
  { id: 4, name: "reload", dir: "tests/layers/04-reload", runner: "vitest", requires: ["pi", "tmux"] },
  { id: 5, name: "rpc", dir: "tests/layers/05-rpc", runner: "vitest", requires: ["pi"] },
  { id: 6, name: "tui", dir: "tests/layers/06-tui", runner: "vitest", requires: ["pi", "tmux"] },
  {
    id: 7,
    name: "third-party",
    dir: "tests/layers/07-third-party",
    runner: "vitest",
    optIn: true,
    requires: ["bun"],
    timeoutMs: 900000,
  },
  { id: 8, name: "user-journeys", dir: "tests/layers/08-user-journeys", runner: "vitest" },
  { id: 9, name: "inventory", dir: "tests/inventory", runner: "vitest" },
  { id: 10, name: "hosted", dir: "tests/hosted", runner: "vitest" },
  { id: 11, name: "acceptance", dir: "tests/acceptance", runner: "vitest" },
  { id: 12, name: "extensions", dir: "extensions/test", runner: "vitest" },
  { id: 13, name: "scripts", dir: "skills/poteto-mode/scripts", runner: "vitest", requires: ["git", "bun"] },
  { id: 14, name: "differential", dir: "tests/differential", runner: "vitest", optIn: true, requires: ["git", "bun"] },
  { id: 15, name: "audit", dir: "tests/audit", runner: "vitest", optIn: true },
];

export const DEFAULT_PROJECTS = LAYERS.filter((layer) => layer.runner === "vitest" && !layer.optIn);
export const OPT_IN_PROJECTS = LAYERS.filter((layer) => layer.runner === "vitest" && layer.optIn);

export function layerByName(name) {
  return LAYERS.find((layer) => layer.name === name);
}
