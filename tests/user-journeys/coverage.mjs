/**
 * Coverage contract math for the user-journey suite.
 *
 * The gate passes when all critical journeys ran and passed (limb B) OR at least 80% of the
 * runtime behavior inventory was observed (limb A), provided every anti-vacuum guard holds.
 *
 * Guards exist so the contract cannot pass against a hollow surface: too few behavior units, a
 * journey that never ran, or a journey that observed nothing all sink the verdict.
 */

function countKind(units, kind) {
  return units.filter((unit) => unit.kind === kind).length;
}

function passWord(ok) {
  return ok ? "PASS" : "FAIL";
}

export function summarizeCoverage({ inventory, observed, results, expectedJourneyIds, threshold = 0.8 }) {
  if (!Array.isArray(expectedJourneyIds) || expectedJourneyIds.length === 0) {
    throw new Error("summarizeCoverage requires expectedJourneyIds from the journey registry");
  }
  const observedIds = new Set(observed);
  const covered = inventory.units.filter((unit) => observedIds.has(unit.id)).length;
  const total = inventory.total;
  const pct = total === 0 ? 0 : (covered / total) * 100;

  const expected = [...expectedJourneyIds];
  const resultsById = new Map(results.map((result) => [result.id, result]));
  const runIds = results.map((result) => result.id);
  const uniqueRan = new Set(runIds);
  const ranOnce =
    uniqueRan.size === runIds.length &&
    expected.every((id) => uniqueRan.has(id)) &&
    runIds.every((id) => expected.includes(id));
  const allPassed = results.length > 0 && results.every((result) => result.status === "pass");
  const orphanJourneys = results.filter((result) => (result.observed ?? []).length === 0).map((result) => result.id);
  const everyJourneyObserved = results.length > 0 && orphanJourneys.length === 0;

  const guards = {
    inventoryFloor: total >= 50,
    commandFloor: countKind(inventory.units, "command") >= 40,
    toolFloor: countKind(inventory.units, "tool") >= 12,
    allJourneysRanOnce: ranOnce,
    everyJourneyObserved,
    noOrphanJourneys: orphanJourneys.length === 0,
  };
  const behaviorLimb = total > 0 && covered / total >= threshold;
  const journeyLimb = ranOnce && allPassed && everyJourneyObserved;
  const verdict = Object.values(guards).every(Boolean) && (behaviorLimb || journeyLimb);

  return {
    threshold,
    behavior: { covered, total, pct },
    behaviorLimb,
    journey: {
      criticalTotal: expected.length,
      criticalPassed: expected.filter((id) => resultsById.get(id)?.status === "pass").length,
      allPassed,
    },
    journeyLimb,
    verdict,
    guards,
    uncovered: inventory.units.filter((unit) => !observedIds.has(unit.id)).map((unit) => unit.id),
    orphanJourneys,
  };
}

export function formatCoverage(report) {
  const { behavior, journey } = report;
  const head = [
    "user-journeys:",
    `journeys=${journey.criticalPassed}/${journey.criticalTotal}`,
    `behavior=${behavior.covered}/${behavior.total}`,
    `(${behavior.pct.toFixed(1)}%)`,
    `threshold=${Math.round(report.threshold * 100)}%`,
    `limbA=${passWord(report.behaviorLimb)}`,
    `limbB=${passWord(report.journeyLimb)}`,
    `verdict=${passWord(report.verdict)}`,
  ].join(" ");
  if (report.uncovered.length === 0) return head;
  return `${head}\nuncovered: ${report.uncovered.join(", ")}`;
}
