/**
 * The audit work list: one predicate per finding, grouped by area. Each entry is
 * a `{id, description, run}` record whose `run` resolves to `{status, detail}`.
 * `audit.test.mjs` turns every entry into one Vitest test.
 */
import { SEC_GUARD_PREDICATES } from "../support/audit/sec-guard.mjs";
import { SEC_TOOL_PREDICATES } from "../support/audit/sec-tools.mjs";
import { SEC_SERVICE_PREDICATES } from "../support/audit/sec-services.mjs";
import { GATE_PREDICATES } from "../support/audit/gate.mjs";
import { PAR_PREDICATES } from "../support/audit/par.mjs";
import { DOC_PREDICATES } from "../support/audit/docs.mjs";
import { AGENTS_PREDICATES } from "../support/audit/agents.mjs";

export const PREDICATES = Object.freeze([
  ...SEC_GUARD_PREDICATES,
  ...SEC_TOOL_PREDICATES,
  ...SEC_SERVICE_PREDICATES,
  ...GATE_PREDICATES,
  ...PAR_PREDICATES,
  ...DOC_PREDICATES,
  ...AGENTS_PREDICATES,
]);
