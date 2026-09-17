/**
 * Differential conformance as a Vitest suite.
 *
 * One test per case definition. The environment is probed once at module scope:
 * the pinned upstream tree and bun are required, and a run that cannot reach them
 * reports the suite as skipped rather than red. Each test measures the case
 * against the upstream tree and this repo's ported twin, then asserts the exit
 * code and the normalized text. afterAll writes spec/differential-results.json
 * even when a case differs, so the committed ledger reflects the last run.
 *
 *   PSTACK_DIFFERENTIAL_DUMP=1  also print each case's normalized text
 *   PSTACK_DIFFERENTIAL_KEEP=1  keep the scratch tree and print its path
 *   PORT_UPSTREAM_DIR=<dir>     resolve upstream from a clone other than the cache
 */
import { afterAll, describe, expect, it } from "vitest";
import { assertCoverage, caseDefinitions, dumpCase, formatMismatch, measureCase, normalizeCases, preflight } from "./cases.mjs";
import { probeEnvironment, writeLine } from "./environment.mjs";
import { buildContext } from "./fixtures.mjs";
import { cleanup, createLedger, resultPayload, writeLedger } from "./ledger.mjs";

const dumpEnabled = process.env.PSTACK_DIFFERENTIAL_DUMP === "1";
const keepScratch = process.env.PSTACK_DIFFERENTIAL_KEEP === "1";

function firstLine(text) {
  return text.trim().split("\n")[0] ?? "";
}

function prepareRun() {
  try {
    const probe = probeEnvironment();
    if (probe.status !== "environment") return probe;
    const ctx = buildContext(probe.resolution, probe.pathBase);
    const watch = preflight(ctx);
    if (watch.rc !== 0) {
      cleanup(ctx, false);
      return { status: "skipped", reason: `bun cannot run the watch-pr CLI (${firstLine(watch.stderr) || `exit ${watch.rc}`})` };
    }
    const definitions = caseDefinitions(normalizeCases(ctx), ctx);
    assertCoverage(ctx, definitions);
    return { status: "ready", ctx, definitions };
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

function readyDefinitions(setup) {
  return setup.status === "ready" ? setup.definitions : [];
}

const setup = prepareRun();
if (setup.status === "error") throw new Error(`differential: harness error (${setup.reason})`);
if (setup.status === "skipped") writeLine(`differential: SKIPPED (${setup.reason})`);

describe.skipIf(setup.status !== "ready")("differential conformance", () => {
  const ledger = createLedger();

  afterAll(() => {
    if (setup.status !== "ready") return;
    try {
      const outcomes = ledger.collect(setup.definitions.map((definition) => definition.id));
      const payload = resultPayload(setup.ctx, outcomes);
      writeLedger(payload);
      writeLine(`differential: cases=${payload.summary.cases} equal=${payload.summary.equal} differ=${payload.summary.differ}`);
    } finally {
      cleanup(setup.ctx, keepScratch);
    }
  });

  for (const definition of readyDefinitions(setup)) {
    it(`case ${definition.id} matches the pinned upstream`, () => {
      const outcome = measureCase(definition, setup.ctx);
      ledger.record(outcome);
      if (dumpEnabled) dumpCase(outcome);
      expect(outcome.upstreamRc, formatMismatch(outcome)).toBe(outcome.portedRc);
      expect(outcome.portedText, formatMismatch(outcome)).toBe(outcome.upstreamText);
    });
  }
});
