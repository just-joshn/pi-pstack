# pstack build contract

## 0. What this is and how to use it

This document is the rebuild contract for pi-pstack. The consumer is an AI with a file reader and a shell.

The bar is 100 percent behavioral-contract parity over the reproducible compatibility surface. That surface is the scoped upstream tree (`skills/`, `agents/`, `automations/`, `docs/`) plus the host mechanisms it names.

Three parity notions govern the work.

- Content parity. The ported tree equals the bindings applied to the pinned upstream commit. `port/port.mjs` owns it.
- Behavioral parity. Each Pi tool and command reimplements one upstream mechanism. The ledger in `spec/contracts/` owns it.
- Reference status. What `PARITY.md` and `README.md` claim versus what the tests prove. The single-sourcing map in section 7 owns it.

The build loop is read the ledger, fix each DEFECT row, add the proof each UNVERIFIED row names, flip it to VERIFIED, and rerun the completion gate. Section 5 gives the milestones.

The ledger is portable. Each row states an obligation. The `status` column describes the tree that contains the ledger. The `reference` column is informational and points at the reference implementation. A builder who starts a new tree keeps the obligations, sets every status to `UNVERIFIED`, leaves `reference` as a dash, and proves each row in the new tree. A maintainer of the reference tree reads the same rows as that tree's current state.

## 1. The contract ledger

The ledger lives in `spec/contracts/`. Every `.tsv` file in that directory is part of the ledger, and the union of those files is the ledger. A row lives in exactly one file. Every file carries the same header line.

```
id	surface	status	kind	name	obligation	verification	upstream	reference	finding	class
```

Columns and their rules.

- `id`. `<surface>-<NN>`, unique across all files, `NN` two digits, the prefix equals the `surface` column.
- `surface`. One slug from `spec/surfaces.tsv`.
- `status`. `VERIFIED`, `UNVERIFIED`, `DEFECT`, or `EXCLUDED`.
- `kind`. `tool`, `command`, `behavior`, or `ceiling`.
- `name`. The exact registered name for `tool` and `command` rows. A dash otherwise.
- `obligation`. One imperative sentence stating the contract. No tabs. Testable.
- `verification`. Per the grammar below.
- `upstream`. An upstream file path relative to the upstream `pstack/` root, or `mechanism:<label>` when no in-tree spec exists. Every `ADAPTED-EQUIVALENT` row names a mechanism here; a row classified by its surface alone does not satisfy the checker.
- `reference`. Repo-relative path and line of the current implementation, or a dash.
- `finding`. `#<n>` from `.pi/audit-findings.md`, or a dash.
- `class`. Exactly one of `EXACT-CONTRACT`, `ADAPTED-EQUIVALENT`, `HOSTED-CAPABILITY-REQUIRED`, `APPROVED-EXCEPTION`. `EXACT-CONTRACT` means Pi reproduces the contract directly. `ADAPTED-EQUIVALENT` means a Pi mechanism stands in for a Cursor mechanism while the contract holds, and every such row names the Cursor mechanism in `upstream` as `mechanism:<label>` with a label that exists in `spec/mechanisms.tsv`. `HOSTED-CAPABILITY-REQUIRED` and `APPROVED-EXCEPTION` are allowed only on `kind=ceiling` rows, and a ceiling row is `ADAPTED-EQUIVALENT` only when its verification is `twin@<surface>` and that surface carries the contract. Every other kind must be `EXACT-CONTRACT` or `ADAPTED-EQUIVALENT`. The checker enforces the mapping, the mechanism label, and rejects vague parity phrases such as `mostly works` or `unsupported by Pi`.

Status state machine.

- `UNVERIFIED` becomes `VERIFIED` when a proof exists and passes.
- `DEFECT` becomes `UNVERIFIED` when the named finding is fixed, then `VERIFIED` when the regression proof passes.
- `EXCLUDED` is terminal. A ceiling row is never claimed as parity.

Verification grammar.

- `VERIFIED`, `test@<relpath>@<name-substring>`. A test file discovered by a non-opt-in layer of `tests/registry.mjs`, containing the substring. Executed by `npm test`.
- `VERIFIED`, `gate@<npm-script>`. An npm script in `package.json` that runs offline with the pin cached.
- `UNVERIFIED`, `todo@<proof to build>`. Free text naming the proof to add.
- `DEFECT`, `fix@#<n>`. The `.pi/audit-findings.md` finding number.
- `DEFECT`, `fix@local:<slug>`. A defect the reference tree carries that has no audit finding number yet.
- `EXCLUDED`, `twin@<surface>`. The surface whose rows carry the feasible twin. At `--require-complete` that surface must have a `VERIFIED` row.

A proof is sufficient when it runs in the default gate, calls the code the way its user does, and asserts the observable result. A test name alone is not a proof. The checker proves only that the test exists, is discovered by a non-opt-in layer, and contains the named substring. When a `todo@` row names a proof, write the smallest test that observes the contract and then cite its file and test name.

Row granularity rules.

1. One independently verifiable behavior per row.
2. `kind=tool` rows use the exact tool name in `name`. Every registered `pstack_*` tool has at least one row. Every row's tool exists.
3. `kind=command` rows cover commands with distinct logic. The generated per-skill `/name` shims are one aggregate row verified by `gate@parity:check`.
4. The obligation states the contract, never the current buggy behavior. A reference implementation that violates its contract is `DEFECT` and names the finding.
5. A row with no upstream in-tree spec still states a contract. Its `upstream` cell names the mechanism. The obligation is justified by the mechanism's purpose.

## 2. The surface checklist

`spec/surfaces.tsv` is the machine-readable surface list. Columns are `slug`, `capability`, `owns`, `upstream_basis`. `capability` mirrors `PARITY.md`'s 12-capability scorecard where one exists. Zero is infrastructure. `owns` is a one-line list of the tools, commands, and files the surface owns. `upstream_basis` is the upstream file, or `none in tree`.

The 20 surfaces and what each owns.

- `content`. Ported tree, bindings, overrides, extras, leftover tokens, `port/contract/alias` gates.
- `commands`. `/skill:<name>` invocation, generated `/name` shims, reserved names, arg forwarding.
- `decision`. `pstack_decision_log`, TSV format, path allowlist.
- `sticky`. `/poteto-mode`, `/poteto-mode-off`, `/pstack`, playbook matching, injection, restore, provenance, child gate.
- `spawn`. `pstack_spawn` roles, model resolution, argv, session dirs, defaults, concurrency, resume.
- `jobs`. `pstack_jobs` list/status/await/abort, states, session scope.
- `swarm`. `pstack_swarm` isolation, N cap, aggregation.
- `arena`. `pstack_arena` candidates, cross-judge, worktree isolation.
- `models`. `/setup-pstack`, config file and precedence, role resolution, always-applied injection.
- `loop`. `pstack_loop`, `/pstack-loop` modes, coalescing, watcher, maxFires, stop/status/list.
- `worktree`. `pstack_worktree` create/list/remove/prune, sanitization, cap, shutdown cleanup.
- `ship`. `pstack_ship` view/merge/gate-check/stack-status, fail-closed merge.
- `babysit`. `pstack_babysit`, recipes, watchArgv, loopArm payload.
- `gates`. `/pstack-gates` and its criteria.
- `deslop`. `pstack_deslop`, `/deslop`, applySafe/dryRun, unslop pairing.
- `control`. `pstack_control_cli`, `pstack_control_ui`.
- `readonly`. `/pstack-readonly(-off)`, tool policy, auto-arm, status.
- `sessions`. `pstack_sessions` list/grep/current/recall, ranking.
- `benny`. `pstack_benny_wake`, `/setup-benny`, `/benny-triage`, `/benny-repro`.
- `ceiling`. EXCLUDED rows only, each naming its twin surface. A ceiling is `HOSTED-CAPABILITY-REQUIRED`, `APPROVED-EXCEPTION`, or `ADAPTED-EQUIVALENT` when a verified twin reproduces the capability. The ceiling rows live in `spec/contracts/companions.tsv` with the companion surfaces.

Completeness directions, and the honest limit of each.

- Tools both ways. Every `name: "pstack_*"` literal in `extensions/**/*.ts` has a `kind=tool` row, and every `kind=tool` row's name exists. Limit: this proves tool registration, not behavior. It matches literal `name:` fields, so a tool registered through a variable or a computed name would not be found.
- Mechanisms via `spec/mechanisms.tsv`. Every mechanism the host-mechanism sweep names has exactly one row. Limit: the sweep is a grep over the pinned upstream. A mechanism absent from the sweep is not covered.
- Mechanism attribution. Every `ADAPTED-EQUIVALENT` row names a mechanism that resolves to a `mechanisms.tsv` row. Limit: this proves the label resolves, not that each attribution is the best available one.
- Commands via the alias gate. `port/alias.mjs` proves reserved and skill names register once and the arg-forwarding helpers are present. Limit: the gate proves registration shape, not argument semantics.

## 3. Coverage rule

```
T = total rows    V = VERIFIED    U = UNVERIFIED
D = DEFECT        E = EXCLUDED    eligible = T - E
coverage = V / eligible
```

100 percent holds when `U == 0` and `D == 0`.

`E` is reported separately and never counts as progress.

`eligible == 0` is a checker failure, not 100 percent.

At completion every `EXCLUDED` row's `twin@<surface>` names a surface with a `VERIFIED` row.

As implemented, the ledger gives `T = 239` with `V = 227`, `U = 0`, `D = 0`, `E = 12`, so `eligible = 227` and `coverage = 100%`. Class split: `ADAPTED-EQUIVALENT = 162`, `EXACT-CONTRACT = 69`, `APPROVED-EXCEPTION = 2`, `HOSTED-CAPABILITY-REQUIRED = 6`. The checker is the authority for these numbers.

## 4. Host ceilings and exclusions

An exclusion must name its twin surface. Never claim parity there. Each ceiling row is `EXCLUDED` and its twin must have a `VERIFIED` row at `--require-complete`.

A ceiling whose capability a verified twin reproduces is `ADAPTED-EQUIVALENT` rather than `APPROVED-EXCEPTION`. Four rows sit there today: `/loop`, `mdc-rules`, `transcript-store`, and `history-inheritance`. The ceiling record stays so the chrome or storage being stood in for remains visible.

The Pi install prefix below is `PI`. It is the installed `@earendil-works/pi-coding-agent` package root. Resolve it with `node -e "console.log(require.resolve('@earendil-works/pi-coding-agent/package.json'))"` and drop the trailing `/package.json`. The path recorded here is the one this spec was authored against.

`PI = /Users/josh-desktop/.local/share/mise/installs/node/24.20.0/lib/node_modules/@earendil-works/pi-coding-agent`

| Ceiling mechanism | Host doc pointer | Twin surface |
|---|---|---|
| marketplace | `PI/docs/packages.md:70-90` (package manifest entries, no plugin marketplace) | `content` |
| cloud-agents | `PI/README.md` Philosophy (no cloud agents) | `worktree` |
| automations-slack | `PI/README.md` Philosophy (no automations) | `benny` |
| grok-bot | `PI/README.md` Philosophy (no webhook cards) | `benny` |
| mcp | `PI/README.md` Philosophy (no MCP) | `spawn` |
| sticky-host | `PI/docs/skills.md:140-152` (unknown frontmatter ignored) | `sticky` |
| /loop | `PI/README.md` Philosophy (no scheduler chrome) | `loop` |
| durable-jobs | `PI/README.md` Philosophy (no background bash) | `jobs` |
| ide-driving | `PI/README.md` Philosophy (no Electron driving) | `control` |
| mdc-rules | `PI/docs/skills.md:140-152` (no rules engine) | `models` |
| transcript-store | `PI/docs/session-format.md:380-430` (SessionManager is SDK-only) | `sessions` |
| history-inheritance | `PI/README.md` Philosophy (no sub-agents) | `spawn` |

The reasoning budget is applied at resolution, not only at setup. `/setup-pstack` writes the budget label into `pstack-models.json`, and `resolveRoleModel` turns it into a Pi thinking level on the selector it returns (`unlimited` becomes `max`, `large` `xhigh`, `medium` `high`, `small` `medium`). An explicit effort token written for a role wins over the budget, and an unrecognized budget leaves the selector untouched. Proven by `models-09`.

Some Pi behaviors deliberately differ from the ported policy. They are not ceilings and not defects. The ledger rows state the Pi contract.

| Divergence | Ported or upstream baseline | Why the Pi behavior differs |
|---|---|---|
| Merge gates are stricter. `BLOCKED`, `BEHIND`, `REVIEW_REQUIRED`, and pending checks block a merge. | The ported watch-pr readiness policy allows `BLOCKED` unless the rollup is a failure, and blocks only `CHANGES_REQUESTED`. | A merge is irreversible. Fail closed and require a human override outside the tool. |
| Shutdown cleanup skips untracked-only worktrees. | `skills/poteto-mode/scripts/worktree-audit.sh` marks untracked-only worktrees safe to drop. | Deleting untracked files loses work the agent never committed. Skipping is the safe direction. |
| Sticky mode injects the prompt on every turn while armed. | The upstream skill's casual-turn carve-out keeps the body out of unrelated turns. | Re-entry gating is the only reliable way to keep a sticky mode armed across a host that re-fires input. |
| Readonly blocks a named tool set and coerces spawns. | Cursor Ask mode strips MCP access at the host. | Pi has no host mode, so the extension owns the policy. The policy covers the tools that write or exec. |
| Skill `name` frontmatter is kebab-case. | Cursor accepts display titles such as `Poteto Mode`. | Pi requires `a-z0-9-`. The slash command stays the same. |

## 5. The builder's path

- **M0 Bootstrap.** Write `spec/`, wire the scripts, apply the single-sourcing edits. Gate: `node spec/spec-check.mjs` exits 0 structurally and prints coverage, and `npm run parity:check` stays green.
- **M1 Enumerate.** Fill `contracts/*.tsv` and `mechanisms.tsv` to completeness. Gate: zero completeness violations; the coverage line is authoritative.
- **M2 Close defects.** Fix each `DEFECT` row (findings 1 through 9, 12, and 13), add the regression proof, flip to `UNVERIFIED`. Gate: `D == 0` and `npm test` green.
- **M3 Prove.** Add the proof each `UNVERIFIED` row names, flip to `VERIFIED`. Gate: `U == 0`.
- **M4 Complete.** Run the completion gate and update the docs. Gate: `npm run spec:gate` exits 0.

Exact commands.

- M0 gate: `node spec/spec-check.mjs` then `npm run parity:check`.
- M1 gate: `node spec/spec-check.mjs`.
- M2 gate: `npm test`.
- M3 gate: `node spec/spec-check.mjs`.
- M4 gate: `npm run spec:gate`.

`spec:gate` is `node spec/spec-check.mjs --require-complete && npm test && npm run parity:check`.

## 6. Host model

Version pin is `0.85.1`, from `PI/package.json:3`.

The builder must use these Pi primitives. Doc pointers are relative to the `PI` prefix from section 4.

| Primitive | Doc pointer |
|---|---|
| Extension entry factory | `PI/docs/extensions.md:152-170` |
| `pi.on(event, handler)` | `PI/docs/extensions.md:174-1330` |
| `pi.registerTool(def)` | `PI/docs/extensions.md:1470-1600`, `1750-1860` |
| `pi.registerCommand(name, {...})` | `PI/docs/extensions.md:1462-1505` |
| `pi.sendUserMessage(content, {...})` | `PI/docs/extensions.md:1425-1460` |
| `pi.appendEntry(customType, data)` | `PI/docs/extensions.md:1444-1465`, `PI/docs/session-format.md:200-210` |
| `ctx.ui.select/confirm/input/editor` | `PI/docs/extensions.md:2500-2560` |
| `ctx.ui.notify/setStatus/setWidget/setTitle/setEditorText` | `PI/docs/extensions.md:2560-2640` |
| `pi.getActiveTools()/getAllTools()/setActiveTools(names)` | `PI/docs/extensions.md:1700-1725` |
| `pi.exec(cmd, args, {signal, timeout})` | `PI/docs/extensions.md:1745-1750` |
| `ctx.sessionManager` | `PI/docs/extensions.md:995-1010`, `PI/docs/session-format.md:380-430` |
| `ctx.model` / `ctx.modelRegistry` / `ctx.thinkingLevel` | `PI/docs/extensions.md:1012-1020` |
| `ctx.cwd` / `ctx.signal` / `ctx.hasUI` | `PI/docs/extensions.md:980-1050` |

Documented host limits from `PI/README.md` Philosophy: no MCP, no sub-agents, no permission popups, no plan mode, no built-in to-dos, no background bash.

## 7. Single-sourcing map

- `spec/SPEC.md`. The contract frame, coverage rule, ceilings, and builder path.
- `spec/surfaces.tsv`. The surface list and ownership.
- `spec/mechanisms.tsv`. Upstream mechanism dispositions.
- `spec/contracts/*.tsv`. The behavioral ledger. The live contract, reference status, and DoD class per row.
- `spec/DIFFERENTIAL.md`. What the repo proves without a Cursor host, and the procedure and fixtures for the Cursor-side comparison.
- `PARITY.md`. Historical scorecard. A banner names `spec/SPEC.md` and `spec/contracts/` as the live contract.
- `README.md`. Install and usage. Replaces the inline status sentence with a pointer to `spec/SPEC.md`.
- `port/README.md`. Content parity mechanics. One line states the behavioral contract lives in `spec/SPEC.md`.
- `tests/README.md`. Test layer structure. One line names the spec checker as the structural layer of `npm test`.
- `CHANGELOG.md`. History. One Unreleased bullet names this spec.
- `.pi/audit-findings.md`. Findings history. No edit.

## 8. What spec-check proves, and what it does not

Two layers.

The checker proves wiring and completeness. It parses the ledger, validates row form, resolves verification references, checks tools both ways, checks surface and mechanism integrity, and prints coverage. It never executes a proof.

The test runner proves behavior. `npm test` executes every `test@` proof through `tests/registry.mjs`. `npm run parity:check` executes every `gate@` proof.

Honest limits. The checker cannot prove a test asserts the right thing. It proves the test exists, is discovered, and contains the named substring. The checker cannot prove `gate@` scripts are correct. It proves the script exists in `package.json`.

## 9. Bumping upstream

The pin lives in `port/upstream.json`. It records `repo`, `subdir`, `version`, `commit`, and `scoped`.

To bump, change `version` and `commit` to the new upstream tag, then run `npm run parity:sync` and `npm run parity:check`.

Drift is any local file under a scoped directory that differs from the bindings applied to the pinned commit. `port/port.mjs check` reports `DRIFT`, `BYTE DRIFT`, `BINARY DRIFT`, `MISSING`, and `UNUSED RULE`. Every binding must fire. An upstream edit that breaks a binding fails as `UNUSED RULE` plus `DRIFT`.

A binding may replace a Cursor mechanism or Cursor metadata. It may not rewrite upstream logic. A Pi-only behavior belongs in the extensions and the ledger, never in a binding.

The procedure lives in `port/README.md`. It owns content parity mechanics. The behavioral contract stays here in `spec/SPEC.md`.
