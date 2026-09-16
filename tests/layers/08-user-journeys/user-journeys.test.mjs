/**
 * Layer 8: user journeys.
 *
 * One node:test per journey, then a coverage-contract test over the whole run. The contract passes
 * when all critical journeys passed or at least 80% of the runtime behavior inventory was observed,
 * and every anti-vacuum guard holds. The machine-checked line is printed to stdout.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJourneyBench } from "../../user-journeys/harness.mjs";
import { formatCoverage, summarizeCoverage } from "../../user-journeys/coverage.mjs";
import { JOURNEYS } from "../../user-journeys/registry.mjs";
import piPstack from "../../../extensions/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function ledgerSurfaces() {
  const rows = readFileSync(join(ROOT, "spec/surfaces.tsv"), "utf8").trimEnd().split("\n").slice(1);
  return new Set(rows.map((row) => row.split("\t")[0]));
}

const bench = await createJourneyBench({ entry: piPstack });

for (const journey of JOURNEYS) {
  test(`journey: ${journey.title}`, async () => {
    await bench.runJourney(journey);
  });
}

test("coverage contract: 80% of user behavior or all critical journeys", () => {
  const report = summarizeCoverage({
    inventory: bench.inventory,
    observed: bench.observed,
    results: bench.results,
    expectedJourneyIds: JOURNEYS.map((journey) => journey.id),
  });
  process.stdout.write(`${formatCoverage(report)}\n`);
  for (const [guard, ok] of Object.entries(report.guards)) {
    assert.equal(ok, true, `guard ${guard} failed; ${formatCoverage(report)}`);
  }
  assert.equal(report.verdict, true, `coverage verdict failed; ${formatCoverage(report)}`);
});

test("journey registry integrity: unique ids, non-empty titles, all critical", () => {
  const ids = JOURNEYS.map((journey) => journey.id);
  const surfaces = ledgerSurfaces();
  assert.ok(JOURNEYS.length >= 1, "journey registry is empty");
  assert.equal(new Set(ids).size, ids.length, `duplicate journey ids: ${ids.join(", ")}`);
  for (const journey of JOURNEYS) {
    assert.ok(journey.title.trim().length > 0, `empty title for ${journey.id}`);
    assert.equal(journey.critical, true, `${journey.id} is not critical`);
    assert.equal(typeof journey.run, "function", `${journey.id} has no run`);
    assert.ok(Array.isArray(journey.surfaces) && journey.surfaces.length > 0, `${journey.id} has no surfaces`);
    for (const surface of journey.surfaces) {
      assert.ok(surfaces.has(surface), `${journey.id} names unknown surface ${surface}`);
    }
  }
});

after(async () => {
  await bench.dispose();
});
