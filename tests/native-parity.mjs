#!/usr/bin/env node
/**
 * Compare this repo's native pstack surface to a reference tree.
 * Usage: node tests/native-parity.mjs [referenceRoot]
 * Default reference: ~/.pi/pstack
 * Exits 1 on any mismatch. Skips with 0 when the reference is absent.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCE = resolve(process.argv[2] ?? join(homedir(), ".pi/pstack"));
const TREES = ["extensions", "agents", "skills", "docs", "automations", "assets"];
const ROOT_FILES = ["README.md"];
const SKIP = new Set([".DS_Store", "node_modules"]);

function walk(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, rel) : [rel];
  });
}

function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function compareTree(name) {
  const leftDir = join(REFERENCE, name);
  const rightDir = join(ROOT, name);
  const left = new Set(walk(leftDir));
  const right = new Set(walk(rightDir));
  const missing = [...left].filter((p) => !right.has(p)).map((p) => `${name}/${p}: missing in repo`);
  const extra = [...right].filter((p) => !left.has(p)).map((p) => `${name}/${p}: extra in repo`);
  const changed = [...left]
    .filter((p) => right.has(p))
    .filter((p) => sha(join(leftDir, p)) !== sha(join(rightDir, p)))
    .map((p) => `${name}/${p}: content differs`);
  return [...missing, ...extra, ...changed];
}

function compareRootFiles() {
  return ROOT_FILES.flatMap((name) => {
    const left = join(REFERENCE, name);
    const right = join(ROOT, name);
    if (!existsSync(left)) return [`${name}: missing in reference`];
    if (!existsSync(right)) return [`${name}: missing in repo`];
    return sha(left) === sha(right) ? [] : [`${name}: content differs`];
  });
}

function comparePiManifest() {
  const left = JSON.parse(readFileSync(join(REFERENCE, "package.json"), "utf8"));
  const right = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const leftPi = JSON.stringify(left.pi);
  const rightPi = JSON.stringify(right.pi);
  return leftPi === rightPi ? [] : [`package.json pi: ${rightPi} != ${leftPi}`];
}

if (!existsSync(REFERENCE)) {
  process.stdout.write(`native-parity: skip (no reference at ${REFERENCE})\n`);
  process.exit(0);
}

const findings = [...TREES.flatMap(compareTree), ...compareRootFiles(), ...comparePiManifest()];
if (findings.length === 0) {
  process.stdout.write(`native-parity: clean vs ${REFERENCE}\n`);
  process.exit(0);
}
process.stdout.write(findings.map((line) => `${line}\n`).join(""));
process.stdout.write(`\nnative-parity: ${findings.length} finding(s)\n`);
process.exit(1);
