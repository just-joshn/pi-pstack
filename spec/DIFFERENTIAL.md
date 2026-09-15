# Differential conformance

Two questions live here. What can this repo prove without a Cursor host, and what
does the Cursor side need when a host is available.

## Machine-checked without Cursor

1. **Content parity.** `npm run parity:check` proves every file under `skills/`,
   `agents/`, `automations/`, and `docs/` is exactly the declared bindings applied
   to the pinned upstream tree (`port/upstream.json`). A local edit outside a
   binding fails as drift.
2. **Contract proofs.** `node spec/spec-check.mjs --require-complete` proves every
   ledger row carries a `test@` proof that a non-opt-in layer of `npm test`
   discovers and runs. `U = 0` and `D = 0` are the completion predicates.
3. **Wiring parity.** `port/alias.mjs` proves one registered command per skill and
   one owner per reserved name. `port/contract.mjs` proves every `pstack_*` tool a
   ported doc names exists, every `scripts/...` path in a skill resolves, and
   bundled script exec bits match upstream.

These three gates compare Pi against the pinned Cursor *content* and against the
Pi *contracts* it declares. They do not execute Cursor.

## Requires a Cursor host

Behavioral comparison against the running Cursor plugin needs a Cursor install
with `pstack` 0.15.2 at the pinned commit. The reproducible procedure:

1. Install the pin (`/add-plugin pstack` from a checkout of the pinned commit, or
   the marketplace entry once published).
2. For each deterministic surface below, run the same fixture in both hosts and
   compare normalized output.
3. Treat a difference in decision, evidence, state change, side effect, or
   required output section as a parity defect. Treat wording differences in
   generated prose as noise, per the definition of done item 15.

Deterministic surfaces and their Pi-side golden behavior:

| Surface | Fixture | Pi-side golden source |
|---|---|---|
| Command recognition | invoke every skill name as `/name` with and without arguments | `tests/layers/01-unit/commands-contracts.test.ts`, `extensions/test/skill-commands.mjs` |
| Playbook routing | the routing table for a fixed prompt set | `tests/layers/01-unit/runtime-wiring.test.ts`, `sticky-session.test.ts` |
| Sticky state | arm, casual turn, strong turn, restart, opt-out | `tests/layers/01-unit/poteto-state.test.ts`, `runtime-wiring.test.ts` |
| Model roles | `/setup-pstack` output and the injected roles section | `tests/layers/01-unit/models-contracts.test.ts`, `models-role-cwd.test.ts` |
| Subagent argv | role, model, resume, background, tools per call | `tests/layers/01-unit/spawn-contracts.test.ts`, `child-runner-units.test.ts` |
| Jobs | list, status, await, abort, shutdown | `tests/layers/01-unit/jobs-contracts.test.ts` |
| Loop | interval, settle, watcher, dynamic, coalesce, stop | `tests/layers/01-unit/loop-contracts.test.ts`, `heartbeat-watcher.test.ts` |
| Gates | every merge-blocking view in the fixture matrix | `tests/layers/01-unit/shipping-gates.test.ts`, `gates-contracts.test.ts` |
| Frontier | merged, mergeable, blocked, unfetchable, complete | `tests/layers/01-unit/shipping-frontier.test.ts` |
| Babysit | recipe resolution, loopArm payload, watch argv | `tests/layers/01-unit/babysit-contracts.test.ts` |
| Worktrees | name and base sanitizers, cap, cleanup rules | `tests/layers/01-unit/worktree-contracts.test.ts` |
| Readonly | per-tool policy table, keep set, release | `tests/layers/01-unit/readonly-state.test.ts`, `runtime-wiring.test.ts` |
| Sessions | corpus dirs, walk depth, filters, ranking | `tests/layers/01-unit/sessions-contracts.test.ts` |
| Deslop | pattern set, safe deletes, caps | `tests/layers/01-unit/deslop-contracts.test.ts` |
| Swarm/arena | selection rule, isolation, judging | `tests/layers/01-unit/swarm-selection.test.ts`, `swarm-contracts.test.ts`, `arena-contracts.test.ts` |
| Decision log | TSV shape, allowlist, formula guard | `tests/layers/02-integration/decision-log.test.mjs` |

Cursor-side surfaces with no automated comparison here are the ones the ledger
classes as `HOSTED-CAPABILITY-REQUIRED` or `APPROVED-EXCEPTION`: the marketplace
install flow, cloud agent placement, the Automations and Slack bus, Grok Bot
cards, MCP discovery, the sticky host chrome, native `/loop`, durable background
jobs, IDE driving, the `.mdc` rules engine, the Cursor transcript format, and the
host's own inheritance rules. Each names a twin surface in
`spec/contracts/companions.tsv` and in `spec/mechanisms.tsv`.

## Limits

This environment has no Cursor host, so the second half of the differential suite
is a written procedure rather than an executed suite. Running it requires a
machine with Cursor installed. The first half runs on every `npm test` and every
`npm run spec:gate`.
