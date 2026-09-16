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
  obligationFor,
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
    behavior: obligationFor(row),
    observableContract: observableContractFor(row),
    classification: row.class,
    piMechanism: referenceList(row.reference),
    prerequisites: prerequisitesFor(row, mechanismOf(row)),
    tests: testsFor(row),
    normalization: normalizationFor(row),
    status: statusFor(row.status, row.class),
    evidence: referenceList(row.reference),
    divergences: divergencesFor(row.id),
    exceptionJustification: row.class === "APPROVED-EXCEPTION" ? obligationFor(row) : null,
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

/**
 * The behavioral grades from the PARITY.md scorecard, keyed by capability
 * number. capabilities.json folds these into `status`, so a capability whose
 * ledger rows are all verified but whose runtime behavior is partial or absent
 * cannot claim "verified". The scorecard is hand-maintained, so this map is
 * authored data and a drift between the two fails the audit gate.
 */
const BEHAVIORAL_SCORECARD = {
  1: "EQUIVALENT",
  2: "EQUIVALENT",
  3: "EQUIVALENT",
  4: "EQUIVALENT",
  5: "EQUIVALENT",
  6: "PARTIAL",
  7: "EQUIVALENT",
  8: "EQUIVALENT",
  9: "NOT",
  10: "NOT",
  11: "EQUIVALENT",
  12: "NOT",
};

const STATUS_BY_SCORECARD = {
  EQUIVALENT: "verified",
  PARTIAL: "partial",
  NOT: "not-equivalent",
};

function capabilityStatus(ledgerRollup, behavioralScore) {
  if (ledgerRollup !== "verified") return "implemented";
  return behavioralScore ? STATUS_BY_SCORECARD[behavioralScore] : "verified";
}

function capabilityEntry(number, surfaces, rows) {
  const owned = surfaces.filter((surface) => splitList(surface.capability).includes(String(number)));
  const slugs = owned.map((surface) => surface.slug);
  const surfaceRows = rows.filter((row) => slugs.includes(row.surface));
  const live = surfaceRows.filter((row) => row.status !== "EXCLUDED");
  const verified = live.filter((row) => row.status === "VERIFIED");
  const excluded = surfaceRows.length - live.length;
  const ledgerRollup = live.length > 0 && verified.length === live.length ? "verified" : "implemented";
  const behavioralScore = BEHAVIORAL_SCORECARD[number] ?? null;
  const excludedNote = excluded > 0 ? `, ${excluded} EXCLUDED row(s) excluded from the rollup` : "";
  return {
    id: String(number),
    title: CAPABILITY_TITLES[number] ?? `capability ${number}`,
    surfaces: slugs,
    status: capabilityStatus(ledgerRollup, behavioralScore),
    ledgerRollup,
    behavioralScore,
    counts: { ledgerRows: surfaceRows.length, inScope: live.length, verified: verified.length, excluded },
    hostedRequired: surfaceRows.some((row) => row.class === "HOSTED-CAPABILITY-REQUIRED"),
    notes: `ledger rollup ${verified.length}/${live.length} in-scope row(s) verified${excludedNote}; PARITY.md behavioral scorecard ${behavioralScore ?? "none"}`,
  };
}

export function buildCapabilities(ledger) {
  const { rows, surfaces } = ledger;
  const capabilities = capabilityNumbers(surfaces).map((number) => capabilityEntry(number, surfaces, rows));
  return {
    schemaVersion: 1,
    generatedFrom: "spec/surfaces.tsv (row counts) and PARITY.md (behavioral scorecard)",
    statusBasis: "status folds the ledger rollup with the PARITY.md behavioral scorecard",
    capabilities,
  };
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
