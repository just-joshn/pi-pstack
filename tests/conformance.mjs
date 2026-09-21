#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectViolations, scannedFiles } from "./support/conformance/collect.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNED_ROOTS = ["tests"];
const args = process.argv.slice(2);

function formatEntry(entry) {
  return entry.violations.map(
    (violation) => `  ${entry.file}:${violation.line} [${violation.rule}] ${violation.detail}`,
  );
}

function summarize(entries) {
  return entries.reduce((sum, entry) => sum + entry.violations.length, 0);
}

const ownedScanned = scannedFiles({ base: ROOT, roots: OWNED_ROOTS });
const owned = collectViolations({ base: ROOT, roots: OWNED_ROOTS });
const hardCount = summarize(owned);
const scanIsEmpty = ownedScanned.length === 0;

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ hard: owned, hardCount, scanned: ownedScanned.length }, null, 2)}\n`);
} else if (scanIsEmpty) {
  process.stdout.write(`conformance: 0 owned files scanned under ${OWNED_ROOTS.join(", ")}; an empty scan is not a pass\n`);
} else {
  const header = `conformance: ${hardCount} violation(s); ${ownedScanned.length} files scanned (owned)`;
  process.stdout.write(`${[header, ...owned.flatMap(formatEntry)].join("\n")}\n`);
}

process.exit(hardCount > 0 || scanIsEmpty ? 1 : 0);
