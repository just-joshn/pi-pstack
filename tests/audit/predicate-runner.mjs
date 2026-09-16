/**
 * Vitest wrapper around the predicate contract. Predicates stay plain
 * `{status, detail}` producers; this module isolates a throw as FAIL and caps
 * each run so a hung subprocess cannot stall the suite.
 */
import { SUBPROCESS_TIMEOUT_MS, errorText } from "../support/audit/harness.mjs";

const STATUSES = Object.freeze(["PASS", "FAIL", "SKIP"]);

function withTimeout(promise, id) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`predicate ${id} exceeded ${SUBPROCESS_TIMEOUT_MS}ms`)),
      SUBPROCESS_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** Coerce a predicate's return value to the `{status, detail}` contract. */
export function normalize(predicateId, outcome) {
  if (!outcome || !STATUSES.includes(outcome.status)) {
    return {
      status: "FAIL",
      detail: `predicate ${predicateId} returned a malformed result: ${JSON.stringify(outcome)}`,
    };
  }
  return { status: outcome.status, detail: String(outcome.detail ?? "") };
}

export async function runPredicate(predicate) {
  try {
    return normalize(predicate.id, await withTimeout(predicate.run(), predicate.id));
  } catch (err) {
    return { status: "FAIL", detail: errorText(err) };
  }
}
