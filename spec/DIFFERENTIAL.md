# Differential conformance

Three questions live here. What this repo proves without a Cursor host, what it
executes directly against the pinned reference's own code, and what still needs a
Cursor agent.

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

## Executed against the pinned reference

`npm run test:differential` (wired into `npm run spec:gate`) runs the pinned
upstream file and the ported twin on identical fixtures with identical argv, env,
and cwd, then compares exit code and normalized stdout. Only volatile tokens are
normalized: timestamps, absolute temp paths, durations, and hex SHAs. A remaining
difference fails the gate rather than being smoothed over. The run writes
`spec/differential-results.json` with the upstream commit, the per-case verdict,
and the normalization applied to each case.

This executes the reference itself, which needs no Cursor account because the
upstream scripts are plain Node or Bun programs. What it cannot exercise is the
reference's *agent turn* behavior, which lives behind the Cursor host.

When the upstream tree is absent or its HEAD does not match the pin, the suite
prints a `SKIPPED` line and exits 0, so the gate stays honest about the pin
rather than silently comparing against nothing.

## Requires a Cursor host

### Status of the Cursor side, 2026-09-16

Attempted on this machine. `cursor-agent` is installed (`2026.09.10-fd3934a`),
the account is authenticated (`✓ Logged in as josh.rg.humphrey@proton.me`), and
`cursor-agent models` lists `auto`, `gpt-5.3-codex-low`, `gpt-5.3-codex`, and the
rest of the account's set. Any agent turn fails on quota:

```text
$ cursor-agent -p --force "Reply with exactly: ok"
ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.
$ echo $?
1
```

So no Cursor turn can run on this account today. The procedure below is the
remaining work, and the reason the Cursor-side comparison is a procedure rather
than a passing suite.

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
cards, MCP discovery, the sticky host chrome, durable background jobs, and IDE
driving. Each names a twin surface in `spec/contracts/companions.tsv` and in
`spec/mechanisms.tsv`. Four ceilings whose capability a verified twin reproduces
(`/loop`, `mdc-rules`, `transcript-store`, `history-inheritance`) are
`ADAPTED-EQUIVALENT` and their contracts are covered by the Pi-side rows above.

## Limits

The Cursor *agent* half of this suite has never been executed, because the
available Cursor account is over its usage limit. That gap is real and is not
papered over: the procedure above is reproducible, the failure evidence is
recorded, and every deterministic surface it would cover has a Pi-side proof
running in `npm test`. The reference *code* half executes on every gate through
`npm run test:differential`.
