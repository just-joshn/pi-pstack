/**
 * Layer 8: user journeys.
 *
 * One Vitest test per journey, then a coverage-contract test over the whole run. The contract passes
 * when all critical journeys passed or at least 80% of the runtime behavior inventory was observed,
 * and every anti-vacuum guard holds. The machine-checked line is printed to stdout.
 */
import { afterAll, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJourneyBench } from "../../user-journeys/harness.mjs";
import { formatCoverage, summarizeCoverage } from "../../user-journeys/coverage.mjs";
import { JOURNEYS } from "../../user-journeys/registry.mjs";
import { repoRoot } from "../../support/repo-root.mjs";
import piPstack from "../../../extensions/index.ts";

const ROOT = repoRoot(import.meta.url);

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
    expect(ok, `guard ${guard} failed; ${formatCoverage(report)}`).toBe(true);
  }
  expect(report.verdict, `coverage verdict failed; ${formatCoverage(report)}`).toBe(true);
});

test("journey registry integrity: unique ids, non-empty titles, all critical", () => {
  const ids = JOURNEYS.map((journey) => journey.id);
  const surfaces = ledgerSurfaces();
  expect(JOURNEYS.length >= 1, "journey registry is empty").toBeTruthy();
  expect(new Set(ids).size, `duplicate journey ids: ${ids.join(", ")}`).toBe(ids.length);
  for (const journey of JOURNEYS) {
    expect(journey.title.trim().length > 0, `empty title for ${journey.id}`).toBeTruthy();
    expect(journey.critical, `${journey.id} is not critical`).toBe(true);
    expect(typeof journey.run, `${journey.id} has no run`).toBe("function");
    expect(Array.isArray(journey.surfaces) && journey.surfaces.length > 0, `${journey.id} has no surfaces`).toBeTruthy();
    for (const surface of journey.surfaces) {
      expect(surfaces.has(surface), `${journey.id} names unknown surface ${surface}`).toBeTruthy();
    }
  }
});

afterAll(async () => {
  await bench.dispose();
});
