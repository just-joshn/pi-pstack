import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"tests/**/*.test.ts",
			"src/skills/statechart/scripts/test/{parse,pipeline}.test.ts",
			"src/skills/poteto-mode/scripts/watch-pr/*.test.ts",
		],
		// Keep the bundled suite runnable with Bun; reuse its assertions under root V8 coverage.
		alias: { "bun:test": "vitest" },
		environment: "node",
		globals: false,
		pool: "forks",
		maxWorkers: "50%",
		isolate: true,
		clearMocks: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		allowOnly: false,
		passWithNoTests: false,
		retry: 0,
		testTimeout: 10_000,
		hookTimeout: 10_000,
		teardownTimeout: 10_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.{ts,js,mjs}"],
			exclude: ["src/**/test/**", "src/**/*.test.ts", "src/**/*.test-helper.ts", "src/**/*.compile.ts"],
			reporter: ["text", "json-summary", "lcov"],
			reportsDirectory: "./coverage",
			clean: true,
			reportOnFailure: true,
			thresholds: {
				lines: 85,
				branches: 80,
				functions: 90,
				statements: 85,
			},
		},
	},
});
