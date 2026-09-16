#!/usr/bin/env node
/**
 * Generate compat/parity.json and compat/capabilities.json from the ledger.
 *
 * The ledger in spec/contracts/*.tsv is the source of truth. parity.json is a
 * projection of the ledger rows plus one inventory row per in-scope artifact of
 * the pinned upstream tree, so a pin bump that adds an artifact fails the
 * inventory gate. capabilities.json rolls the rows up per capability number.
 *
 *   node compat/generate.mjs
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { loadLedger } from "./lib/ledger.mjs";
import {
  CLASSIFICATIONS,
  STATUSES,
  categorize,
  divergencesFor,
  isMechanismCell,
  mechanismName,
  normalizationFor,
  observableContractFor,
  prerequisitesFor,
  referenceList,
  statusFor,
  testsFor,
  upstreamPathFor,
} from "./lib/mapping.mjs";
import { buildInventoryRows, resolveUpstreamRoot, walkArtifacts } from "./lib/inventory.mjs";
import { splitList } from "./lib/tsv.mjs";

const CAPABILITY_TITLES = {
  0: "infrastructure",
  1: "poteto-mode sticky + playbook routing",
  2: "Task / subagent → spawn / swarm / arena",
  3: "/loop → pstack_loop",
  4: "worktrees isolation",
  5: "shipping / babysit (gh)",
  6: "deslop / control companions",
  7: "model role routing",
  8: "recall",
  9: "make-bot-ui",
  10: "Benny",
  11: "Ask-mode / readonly semantics",
  12: "Automations / cloud agents / marketplace",
};

export function renderJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function mechanismOf(row) {
  return isMechanismCell(row.upstream) ? mechanismName(row.upstream) : "";
}

export function buildBehavioralRow(row, lock) {
  return {
    id: row.id,
    category: categorize(row),
    upstreamRevision: lock.commit.sha,
    upstreamPath: upstreamPathFor(row),
    behavior: row.obligation,
    observableContract: observableContractFor(row),
    classification: row.class,
    piMechanism: referenceList(row.reference),
    prerequisites: prerequisitesFor(row, mechanismOf(row)),
    tests: testsFor(row),
    normalization: normalizationFor(row),
    status: statusFor(row.status, row.class),
    evidence: referenceList(row.reference),
    divergences: divergencesFor(row.id),
    exceptionJustification: row.class === "APPROVED-EXCEPTION" ? row.obligation : null,
  };
}

function countBy(items, key, vocabulary) {
  return Object.fromEntries(vocabulary.map((value) => [value, items.filter((item) => item[key] === value).length]));
}

export function buildParityMatrix(ledger, artifacts) {
  const { rows, lock } = ledger;
  const behavioral = rows.map((row) => buildBehavioralRow(row, lock));
  const inventory = buildInventoryRows(lock, artifacts);
  const all = [...behavioral, ...inventory].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schemaVersion: 1,
    upstreamRevision: lock.commit.sha,
    pluginVersion: lock.pluginVersion,
    capturedAt: lock.capturedAt,
    generatedFrom: "spec/contracts/*.tsv",
    totals: {
      byClassification: countBy(all, "classification", CLASSIFICATIONS),
      byStatus: countBy(all, "status", STATUSES),
    },
    rows: all,
  };
}

function capabilityNumbers(surfaces) {
  const numbers = surfaces.flatMap((surface) => splitList(surface.capability).map((n) => Number.parseInt(n, 10)));
  return [...new Set(numbers)].toSorted((a, b) => a - b);
}

function capabilityEntry(number, surfaces, rows) {
  const owned = surfaces.filter((surface) => splitList(surface.capability).includes(String(number)));
  const slugs = owned.map((surface) => surface.slug);
  const surfaceRows = rows.filter((row) => slugs.includes(row.surface));
  const live = surfaceRows.filter((row) => row.status !== "EXCLUDED");
  const verified = live.filter((row) => row.status === "VERIFIED");
  const excluded = surfaceRows.length - live.length;
  return {
    id: String(number),
    title: CAPABILITY_TITLES[number] ?? `capability ${number}`,
    surfaces: slugs,
    status: live.length > 0 && verified.length === live.length ? "verified" : "implemented",
    hostedRequired: surfaceRows.some((row) => row.class === "HOSTED-CAPABILITY-REQUIRED"),
    notes: `${surfaceRows.length} ledger row(s), ${verified.length} verified, ${excluded} excluded`,
  };
}

export function buildCapabilities(ledger) {
  const { rows, surfaces } = ledger;
  const capabilities = capabilityNumbers(surfaces).map((number) => capabilityEntry(number, surfaces, rows));
  return { schemaVersion: 1, generatedFrom: "spec/surfaces.tsv", capabilities };
}

export function buildArtifacts(repoRoot, ledger) {
  const upstream = resolveUpstreamRoot(repoRoot, ledger.lock);
  if (!upstream) {
    process.stderr.write(
      `compat: no pinned upstream tree at ${join(repoRoot, ".port-upstream")}; run \`npm run parity:check\` to populate it\n`,
    );
    process.exit(1);
  }
  return walkArtifacts(upstream.root, ledger.lock.scoped ?? []);
}

function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ledger = loadLedger(repoRoot);
  const parity = buildParityMatrix(ledger, buildArtifacts(repoRoot, ledger));
  const capabilities = buildCapabilities(ledger);
  writeFileSync(join(repoRoot, "compat", "parity.json"), renderJson(parity));
  writeFileSync(join(repoRoot, "compat", "capabilities.json"), renderJson(capabilities));
  process.stdout.write(`compat: wrote parity.json (${parity.rows.length} rows) and capabilities.json\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
