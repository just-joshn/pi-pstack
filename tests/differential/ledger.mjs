/**
 * Run ledger.
 *
 * The payload shape is fixed: compat/report.mjs reads `upstreamCommit` and
 * `summary` from spec/differential-results.json, and the committed case rows are
 * the audit trail. `createLedger` records measured outcomes in a closure so the
 * suite never shares mutable module state between tests.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, writeLine } from "./environment.mjs";

const RESULTS_PATH = join(ROOT, "spec/differential-results.json");

export function createLedger() {
  const outcomes = new Map();
  return {
    record: (outcome) => outcomes.set(outcome.id, outcome),
    collect: (ids) =>
      ids.map((id) => {
        const outcome = outcomes.get(id);
        if (outcome === undefined) throw new Error(`case ${id} produced no measurement; refusing to write a partial ledger`);
        return outcome;
      }),
  };
}

// The artifact records a repo-relative upstream path so a committed run does not
// carry a machine-specific home directory.
function displayPath(target) {
  const rel = relative(ROOT, target);
  return rel.startsWith("..") ? target : rel;
}

export function resultPayload(ctx, outcomes) {
  const cases = outcomes.map((outcome) => ({
    id: outcome.id,
    equal: outcome.equal,
    upstreamRc: outcome.upstreamRc,
    portedRc: outcome.portedRc,
    normalization: outcome.normalization,
  }));
  const equal = cases.filter((entry) => entry.equal).length;
  return {
    generatedAt: new Date().toISOString(),
    upstreamDir: displayPath(ctx.upstreamDir),
    upstreamCommit: ctx.upstreamCommit,
    cases,
    summary: { cases: cases.length, equal, differ: cases.length - equal },
  };
}

export function writeLedger(payload) {
  writeFileSync(RESULTS_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

export function cleanup(ctx, keep) {
  if (keep) {
    writeLine(`note scratch kept at ${ctx.tmp}`);
    return;
  }
  try {
    rmSync(ctx.tmp, { recursive: true, force: true });
  } catch {
    writeLine(`note scratch not removed: ${ctx.tmp}`);
  }
}
