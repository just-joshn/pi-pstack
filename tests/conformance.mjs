#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectViolations, scannedFiles } from "./support/conformance/collect.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNED_ROOTS = ["extensions", "tests", "port", "spec", "compat", "services"];
const PORTED_ROOTS = ["skills", "agents", "automations", "docs"];
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
const portedScanned = args.includes("--all") ? scannedFiles({ base: ROOT, roots: PORTED_ROOTS }) : [];
const owned = collectViolations({ base: ROOT, roots: OWNED_ROOTS });
const ported = args.includes("--all") ? collectViolations({ base: ROOT, roots: PORTED_ROOTS, owned: false }) : [];
const hardCount = summarize(owned);
const warnCount = summarize(ported);
const scanIsEmpty = ownedScanned.length === 0;

if (args.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify({ hard: owned, warn: ported, hardCount, warnCount, scanned: ownedScanned.length }, null, 2)}\n`,
  );
} else if (scanIsEmpty) {
  process.stdout.write(
    `conformance: 0 owned files scanned under ${OWNED_ROOTS.join(", ")}; an empty scan is not a pass\n`,
  );
} else {
  const header =
    `conformance: ${hardCount} violation(s); ${ownedScanned.length} files scanned (owned)` +
    (portedScanned.length > 0 ? `, ${portedScanned.length} files scanned (ported tree, ${warnCount} warn)` : "");
  const warnSection = ported.length > 0 ? ["ported tree (parity-pinned, warn only):", ...ported.flatMap(formatEntry)] : [];
  process.stdout.write(`${[header, ...owned.flatMap(formatEntry), ...warnSection].join("\n")}\n`);
}

process.exit(hardCount > 0 || scanIsEmpty ? 1 : 0);
