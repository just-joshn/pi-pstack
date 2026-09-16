/**
 * The audit work list as Vitest tests: one test per predicate, named by its id
 * and description. A FAIL predicate fails the test, a SKIP predicate skips it,
 * and every non-FAIL detail is kept as a test annotation. Filter to one area
 * with `-t GATE-`, which replaces the old `--only` flag.
 */
import { expect, test } from "vitest";
import { PREDICATES } from "./predicates.mjs";
import { runPredicate } from "./predicate-runner.mjs";

const PREDICATE_TIMEOUT_MS = 130_000;

function register(predicate) {
  test(`${predicate.id} ${predicate.description}`, { timeout: PREDICATE_TIMEOUT_MS }, async (ctx) => {
    const result = await runPredicate(predicate);
    if (result.status === "SKIP") return ctx.skip(result.detail);
    await ctx.annotate(`${result.status}: ${result.detail}`, result.status);
    expect(result.status, `FAIL ${predicate.id}: ${result.detail}`).toBe("PASS");
  });
}

PREDICATES.forEach(register);
