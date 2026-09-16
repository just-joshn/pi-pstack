#!/usr/bin/env node
/**
 * Audit predicate harness.
 *
 * One predicate per audit finding. Each returns {status, detail}; the runner
 * isolates failures so a throwing predicate reports FAIL instead of aborting the
 * run. Red is the expected state before the remediation wave: this file is the
 * work list, and a fix is done when its predicate turns green.
 *
 *   node tests/audit-predicates.mjs [--json] [--only <id-prefix>]
 *
 * Exits 1 when any predicate FAILs.
 */
import { SUBPROCESS_TIMEOUT_MS, errorText } from "./support/audit/harness.mjs";
import { SEC_GUARD_PREDICATES } from "./support/audit/sec-guard.mjs";
import { SEC_TOOL_PREDICATES } from "./support/audit/sec-tools.mjs";
import { SEC_SERVICE_PREDICATES } from "./support/audit/sec-services.mjs";
import { GATE_PREDICATES } from "./support/audit/gate.mjs";
import { PAR_PREDICATES } from "./support/audit/par.mjs";
import { DOC_PREDICATES } from "./support/audit/docs.mjs";
import { AGENTS_PREDICATES } from "./support/audit/agents.mjs";

const PREDICATES = Object.freeze([
  ...SEC_GUARD_PREDICATES,
  ...SEC_TOOL_PREDICATES,
  ...SEC_SERVICE_PREDICATES,
  ...GATE_PREDICATES,
  ...PAR_PREDICATES,
  ...DOC_PREDICATES,
  ...AGENTS_PREDICATES,
]);

const STATUSES = Object.freeze(["PASS", "FAIL", "SKIP"]);

function parseArgs(argv) {
  const onlyIndex = argv.indexOf("--only");
  return {
    json: argv.includes("--json"),
    only: onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined,
  };
}

function write(line) {
  process.stdout.write(`${line}\n`);
}

function normalize(id, outcome) {
  if (!outcome || !STATUSES.includes(outcome.status)) {
    return { id, status: "FAIL", detail: `predicate returned a malformed result: ${JSON.stringify(outcome)}` };
  }
  return { id, status: outcome.status, detail: String(outcome.detail ?? "") };
}

function withTimeout(promise, id) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`predicate exceeded ${SUBPROCESS_TIMEOUT_MS}ms`)),
      SUBPROCESS_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function runPredicate(predicate) {
  try {
    return normalize(predicate.id, await withTimeout(predicate.run(), predicate.id));
  } catch (err) {
    return { id: predicate.id, status: "FAIL", detail: errorText(err) };
  }
}

function tally(results, status) {
  return results.filter((result) => result.status === status).length;
}

function selected(only) {
  if (!only) return PREDICATES;
  return PREDICATES.filter((predicate) => predicate.id.startsWith(only));
}

async function runAll(predicates, { json }) {
  let results = [];
  for (const predicate of predicates) {
    const result = await runPredicate(predicate);
    const enriched = { ...result, description: predicate.description };
    results = [...results, enriched];
    if (!json) write(`${enriched.status.padEnd(4)}  ${enriched.id.padEnd(10)}  ${enriched.description}`);
  }
  return results;
}

async function main() {
  const { json, only } = parseArgs(process.argv.slice(2));
  const predicates = selected(only);
  if (predicates.length === 0) {
    write(`no predicate matches --only ${only}`);
    process.exitCode = 1;
    return;
  }
  const results = await runAll(predicates, { json });
  const counts = {
    pass: tally(results, "PASS"),
    fail: tally(results, "FAIL"),
    skip: tally(results, "SKIP"),
  };
  if (json) {
    write(JSON.stringify({ results: results.map(({ id, status, detail }) => ({ id, status, detail })), ...counts }));
  } else {
    write("");
    for (const result of results.filter((entry) => entry.status !== "PASS")) {
      write(`${result.status}  ${result.id}: ${result.detail}`);
    }
    write("");
    write(`${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`);
  }
  if (counts.fail > 0) process.exitCode = 1;
}

await main();
