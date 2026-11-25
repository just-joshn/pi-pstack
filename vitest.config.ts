import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,

    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,mts}"],
      exclude: [
        "**/*.d.{ts,mts}",
        "**/*.{test,spec}.{ts,mts}",
      ],
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,

      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
        perFile: true,
        autoUpdate: false,
      },
    },
  },
});