/**
 * Shared project builder. Every layer in `tests/registry.mjs` becomes one Vitest
 * project, so a layer keeps its own timeout and tool preflight while sharing the
 * root pool.
 */
const TEST_GLOB = "**/*.test.{ts,mjs}";
const DEFAULT_TIMEOUT_MS = 60_000;

export function projectFor(layer) {
  if (layer.runner !== "vitest") {
    throw new Error(`layer ${layer.name} is not a Vitest project`);
  }
  return {
    test: {
      name: layer.name,
      include: [`${layer.dir}/${TEST_GLOB}`],
      pool: "forks",
      isolate: true,
      testTimeout: layer.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      hookTimeout: layer.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      globalSetup: ["./tests/support/vitest.global-setup.mjs"],
    },
  };
}
