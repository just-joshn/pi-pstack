import { defineConfig } from "vitest/config";
import { DEFAULT_PROJECTS } from "./tests/registry.mjs";
import { projectFor } from "./tests/support/vitest-project.mjs";

export default defineConfig({
  test: {
    projects: DEFAULT_PROJECTS.map(projectFor),
  },
});
