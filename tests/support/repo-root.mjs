import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the repository root by walking up to the directory that holds both
 * `package.json` and `tests/`, rather than by counting `..` segments.
 *
 * Counting segments couples a test to its own depth: moving a file one level
 * silently retargets every relative read. Depending on the assertion that
 * either fails loudly or, worse, passes against a neighbouring directory. The
 * marker pair makes the answer independent of where the caller lives.
 */
export function repoRoot(from = import.meta.url) {
  const start = dirname(fileURLToPath(from));
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "tests"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no repository root above ${start}`);
    dir = parent;
  }
}
