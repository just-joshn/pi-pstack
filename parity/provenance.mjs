#!/usr/bin/env node
// Every file in the package must trace to this port (created in this repo, or the live port it was built from)
// or to vendored upstream pstack 0.15.5. Prints files that trace only to the pre-0.15.5 pi-pstack tree.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const LIVE = join(homedir(), ".pi/agent");
const UP = join(REPO, "parity/upstream/0.15.5/pstack");
const sources = (rel) => [
  join(UP, rel),
  join(LIVE, rel),
  join(LIVE, "pstack", rel),
  join(LIVE, "pstack/parity", rel.replace(/^parity\//, "").replace(/^probes\//, "round3-probes/")),
  join(LIVE, "pstack/pstack-agents", rel),
];
const OURS = /^(package\.json|package-lock\.json|tsconfig\.json|\.gitignore|parity\/(PACKAGE-PLAN\.md|build-from-live\.mjs|provenance\.mjs|decisions-package\.tsv|harness\/|baseline\/|upstream\/))/;
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: REPO, encoding: "utf8" })
  .split("\n").filter((f) => f && existsSync(join(REPO, f)));
const oldOnly = files.filter((rel) => {
  if (OURS.test(rel)) return false;
  const body = readFileSync(join(REPO, rel));
  return !sources(rel).some((src) => existsSync(src) && (rel.startsWith("skills/") || rel.startsWith("agents/") || rel.startsWith("extensions/") || rel.startsWith("parity/") || readFileSync(src).equals(body)));
});
for (const rel of oldOnly) console.log(rel);
process.exitCode = oldOnly.length ? 1 : 0;
