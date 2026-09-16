#!/usr/bin/env node
/**
 * Parity matrix checker.
 *
 * Fails when compat/parity.json is missing, invalid against
 * compat/parity.schema.json, stale against a fresh generation, missing a ledger
 * row, carries an unknown classification or status, has an APPROVED-EXCEPTION
 * row with no justification, has a HOSTED-CAPABILITY-REQUIRED row with no
 * prerequisite, or has duplicate ids. compat/dependencies.json is validated
 * against an embedded schema and must list every mechanisms.tsv row once.
 *
 *   node compat/check.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLedger } from "./lib/ledger.mjs";
import { CLASSIFICATIONS, STATUSES } from "./lib/mapping.mjs";
import { validateNode } from "./lib/schema-validate.mjs";
import { buildArtifacts, buildCapabilities, buildParityMatrix, renderJson } from "./generate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEPENDENCIES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "dependencies"],
  properties: {
    schemaVersion: { const: 1 },
    dependencies: { type: "array", items: { $ref: "#/$defs/dependency" } },
  },
  $defs: {
    dependency: {
      type: "object",
      additionalProperties: false,
      required: ["id", "upstreamEvidence", "disposition", "piMechanism", "verification", "notes"],
      properties: {
        id: { type: "string", minLength: 1 },
        upstreamEvidence: { type: "string", minLength: 1 },
        disposition: { enum: ["reproduced", "prerequisite", "hosted", "exception"] },
        piMechanism: { type: "string" },
        verification: { type: "string", minLength: 1 },
        notes: { type: "string" },
      },
    },
  },
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function duplicateIds(items) {
  const counts = items.reduce((acc, item) => ({ ...acc, [item.id]: (acc[item.id] ?? 0) + 1 }), {});
  return Object.entries(counts)
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
}

function structuralErrors(parity) {
  const schema = readJson(join(ROOT, "compat", "parity.schema.json"));
  return validateNode(schema, parity).map((line) => `schema: ${line}`);
}

function rowErrors(parityRows, ledgerIds) {
  const present = parityRows.map((row) => row.id);
  const missing = [...ledgerIds].filter((id) => !present.includes(id)).map((id) => `missing ledger row ${id}`);
  const duplicates = duplicateIds(parityRows).map((id) => `duplicate row id ${id}`);
  const badClass = parityRows.filter((row) => !CLASSIFICATIONS.includes(row.classification)).map((row) => `row ${row.id}: bad classification`);
  const badStatus = parityRows.filter((row) => !STATUSES.includes(row.status)).map((row) => `row ${row.id}: bad status`);
  const badException = parityRows
    .filter((row) => row.classification === "APPROVED-EXCEPTION" && !String(row.exceptionJustification ?? "").trim())
    .map((row) => `row ${row.id}: APPROVED-EXCEPTION without justification`);
  const badHosted = parityRows
    .filter((row) => row.classification === "HOSTED-CAPABILITY-REQUIRED" && (row.prerequisites ?? []).length === 0)
    .map((row) => `row ${row.id}: HOSTED-CAPABILITY-REQUIRED without prerequisite`);
  return [...missing, ...duplicates, ...badClass, ...badStatus, ...badException, ...badHosted];
}

function dependencyErrors(mechanisms) {
  const path = join(ROOT, "compat", "dependencies.json");
  if (!existsSync(path)) return ["dependencies.json missing"];
  const doc = readJson(path);
  const schemaErrors = validateNode(DEPENDENCIES_SCHEMA, doc).map((line) => `dependencies schema: ${line}`);
  const entries = Array.isArray(doc.dependencies) ? doc.dependencies : [];
  const known = new Set(mechanisms.map((row) => row.mechanism));
  const ids = entries.map((entry) => entry.id);
  const missing = [...known].filter((id) => !ids.includes(id)).map((id) => `dependencies missing mechanism ${id}`);
  const extra = ids.filter((id) => !known.has(id)).map((id) => `dependencies unknown mechanism ${id}`);
  const duplicates = duplicateIds(entries).map((id) => `dependencies duplicate mechanism ${id}`);
  return [...schemaErrors, ...missing, ...extra, ...duplicates];
}

function stalenessErrors(ledger) {
  const artifacts = buildArtifacts(ROOT, ledger);
  const expectedParity = renderJson(buildParityMatrix(ledger, artifacts));
  const expectedCapabilities = renderJson(buildCapabilities(ledger));
  const parityStale = readFileSync(join(ROOT, "compat", "parity.json"), "utf8") !== expectedParity;
  const capabilitiesStale = readFileSync(join(ROOT, "compat", "capabilities.json"), "utf8") !== expectedCapabilities;
  return [
    ...(parityStale ? ["parity.json is stale; run `npm run compat:generate`"] : []),
    ...(capabilitiesStale ? ["capabilities.json is stale; run `npm run compat:generate`"] : []),
  ];
}

function summaryLine(parity) {
  const totals = parity.totals ?? {};
  return `rows=${parity.rows.length} byStatus=${JSON.stringify(totals.byStatus)} byClassification=${JSON.stringify(totals.byClassification)}`;
}

function main() {
  const parityPath = join(ROOT, "compat", "parity.json");
  if (!existsSync(parityPath)) {
    process.stdout.write("compat:check: parity.json missing; run `npm run compat:generate`\n");
    process.exitCode = 1;
    return;
  }
  const ledger = loadLedger(ROOT);
  const ledgerIds = new Set(ledger.rows.map((row) => row.id));
  const parity = readJson(parityPath);
  const errors = [
    ...structuralErrors(parity),
    ...rowErrors(parity.rows, ledgerIds),
    ...dependencyErrors(ledger.mechanisms),
    ...stalenessErrors(ledger),
  ];
  for (const line of errors) process.stderr.write(`compat:check: ${line}\n`);
  process.stdout.write(`${summaryLine(parity)}\n`);
  process.exitCode = errors.length > 0 ? 1 : 0;
}

main();
