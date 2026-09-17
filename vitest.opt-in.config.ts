/**
 * Opt-in suites. They install packages (third-party), clone upstream
 * (differential), or audit known-red findings (audit), so they stay out of the
 * default `vitest run` and keep their own npm scripts.
 */
import { defineConfig } from "vitest/config";
import { OPT_IN_PROJECTS } from "./tests/registry.mjs";
import { projectFor } from "./tests/support/vitest-project.mjs";

export default defineConfig({
  test: {
    projects: OPT_IN_PROJECTS.map(projectFor),
  },
});
