type Register = (name: string, run: () => void) => void;

// Share synchronous suites between the bundled Node test command and root Vitest coverage.
const runner = process.env.VITEST === "true" ? await import("vitest") : await import("node:test");
export const describe: Register = runner.describe;
export const test: Register = runner.test;
