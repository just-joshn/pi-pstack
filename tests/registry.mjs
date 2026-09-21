/**
 * Test layer manifest.
 *
 * Native pstack has three extensions and the ported orch/watch-pr suites.
 * check-port.mjs is a command gate in npm test, not a Vitest project.
 */
export const LAYERS = [
  { id: 0, name: "conformance", runner: "commands" },
  { id: 1, name: "unit", dir: "tests/native", runner: "vitest" },
];

export const DEFAULT_PROJECTS = LAYERS.filter((layer) => layer.runner === "vitest" && !layer.optIn);
export const OPT_IN_PROJECTS = LAYERS.filter((layer) => layer.runner === "vitest" && layer.optIn);

export function layerByName(name) {
  return LAYERS.find((layer) => layer.name === name);
}
