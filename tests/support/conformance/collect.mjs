import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { auditSource } from "./rules.mjs";

export const CODE_EXTENSIONS = new Set([".ts", ".mjs", ".js", ".cjs"]);

export function walkCodeFiles(dir, base, out = []) {
  let next = out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) next = walkCodeFiles(full, base, next);
    else if (CODE_EXTENSIONS.has(extname(name))) next = [...next, relative(base, full)];
  }
  return next;
}

export function scannedFiles({ base, roots }) {
  return roots
    .filter((root) => existsSync(join(base, root)))
    .flatMap((root) => walkCodeFiles(join(base, root), base))
    .toSorted();
}

export function collectViolations({ base, roots, owned = true }) {
  return scannedFiles({ base, roots })
    .map((file) => ({
      file,
      violations: auditSource(readFileSync(join(base, file), "utf8"), { owned }),
    }))
    .filter((entry) => entry.violations.length > 0);
}
