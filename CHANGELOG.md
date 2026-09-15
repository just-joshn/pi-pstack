# Changelog

## Unreleased

### Added
- Layer 0 of `npm test` enforces the AGENTS.md style rules over project-owned code: `npm run conformance` fails on files over 800 lines, functions over 50 lines, control nesting deeper than four, `console.log`, in-place mutating calls (`.push`/`.sort`/`splice`/`++`/`delete`), empty catch blocks, and hardcoded secret patterns. The byte-pinned ported tree is reported warn-only (`npm run conformance -- --all`) because `port/port.mjs` owns those bytes. Rule implementation lives in `tests/support/conformance/` with its own unit tests.
- Seven-layer test setup with a single runner: `npm test` runs pure unit tests, an in-process SDK + faux-provider integration harness, the real CLI load smoke test (with a broken-extension negative control), a tmux `/reload` dev-loop test, RPC UI tests, tmux TUI tests, and an opt-in `pi-test-harness` compatibility gate. Layer 7 is skipped by default and never touches the network. [`tests/README.md`](./tests/README.md) documents the matrix, flags, and exit codes.
- Strict content parity is now machine-checked: the ported tree (`skills/`, `agents/`, `automations/`, `docs/`) is `apply(declared Cursor→Pi bindings, upstream pstack@v0.15.2)`. `npm run parity:check` fails on drift, an unmigrated Cursor mechanism, a missing override section, an unknown `pstack_*` tool, or a dead `scripts/...` path. See [`port/README.md`](./port/README.md).

### Changed
- The conformance checker now recognises typed and generic function signatures (`): ReturnType {`), which it previously classified as blocks. The stricter gate exposed 12 functions over the 50-line rule; all 12 are split into named helpers across `heartbeat`, `companions`, `benny`, `models`, `worktree`, `shipping`, `decision-log`, `subagents`, `poteto-state`, and `readonly-state`.
- The extension composition root is split by feature: `extensions/poteto-state/` owns sticky state, `extensions/readonly-state/` owns session readonly and the tool policy, and `extensions/effects.ts` applies recorded effects. State records are immutable, transitions are pure functions, and `extensions/index.ts` is a 47-line composition root.
- `port/bindings.mjs` is split into `port/bindings/` (`rules-a`, `rules-benny`, `overrides`, `leftovers`, `index`); the four exported tables are deep-equal to the original in order and content, and the port CLIs no longer mutate or use `console.log`.
- Every remaining in-place mutation, `console.log`, empty catch, over-long function, and secret-pattern hit in `extensions/`, `tests/`, and `port/` is removed. `npm run conformance` reports zero violations.
- `pstack_worktree` cleanup skips a worktree whose `.pi/pstack-child-sessions` has a `.jsonl` touched in the last 30 minutes, so a shutdown in the main repo can no longer delete a worktree while a child runs inside it.
- Every ported file was regenerated from upstream through the binding table. Surplus Pi commentary, duplicated mechanics, and hand-rewritten prose are gone; 103 of 153 upstream files are byte-identical, 48 are binding-only, and 2 are declared whole-mechanism overrides (`make-bot-ui`, `setup-pstack`) whose `must` list pins named upstream sections and whose leftover scan rejects Cursor mechanisms.
- Fixed bindings the previous hand port missed: `reflect/references/synthesizer.md` `create-skill` rows, `reflect` `Task` response wording, and the `worktree-audit.sh` transcript path.

### Fixed
- `pstack_deslop` with both `dryRun: true` and `autoApply: true` now stops at the dry run. The previous guard order could prompt and apply safe deletes despite the dry run.
- An independent review of the refactor found six regressions the test matrix did not cover, all fixed: `tests/support/rpc-client.mjs` returned stale array references so `rpc.next()` always timed out (now pinned by a layer-5 test), `pstack_deslop` reported `details.cwd` as empty, heartbeat loop ids advanced the sequence counter for explicit ids, `enqueueBackgroundChild` called `onComplete` inside the try so a throwing callback reclassified a finished job and fired twice, `prepareChildInputFromParams` omitted `background` from its type, and worktree isolation/cleanup plus the ship stack-status `gh` calls had been made concurrent, which changes cap and error semantics; they are sequential again.
- `port/port.mjs` now skips `node_modules` when walking the ported tree. Dependency files under `skills/poteto-mode/scripts/node_modules` were being reported as undeclared local-only extras, so `npm run parity:check` exited 1 despite 0 drift.
- Pi skill id: `skills/poteto-mode/SKILL.md` frontmatter `name` is `poteto-mode` (kebab-case). Cursor upstream uses display name `Poteto Mode`; Pi requires `a-z0-9-hyphen` only. The slash command remains `/poteto-mode` / `/skill:poteto-mode` for parity of invocation.
- Adversarial-verification round: byte-safe port checker (Buffer.equals first, BYTE DRIFT/BINARY DRIFT, sync refuses binaries), declared local-only extras gate, Benny host bindings (Cursor /automate and Automations-editor wording replaced with a user-provided host), make-bot-ui restored generic HTTP 200 success line, why readonly bindings tightened against the false upstream premise, arena-cross-judge-readonly rule removed so arena reverts to upstream text, and session-readonly auto-arm now requires an explicit playbooks/investigation invocation.

## docs-sync

- Stage 2 docs-sync after close-orch-p0/p1/p1b: README lead = Verifier scorecard (EQUIVALENT sticky/Task/loop/worktrees/ship/models/recall/readonly; PARTIAL deslop only; NOT cloud/marketplace/Automations); tool table documents background omit→true + `resumeSessionDir`/`resumeJobId` → `--session-dir` + `--continue`/`-c`; PARITY inventory `skills/swarm` reframed as EQUIVALENT local-gather (cloud twin only); guides/prompts/agents/playbooks align spawn/resume/jobs/loop; honesty note that Pi `continueRecent` is **cwd-affined** (prefer same cwd on resume or `--session` file when known).


## close-orch-p1b

- Cap2 true resume continue: `resumeSessionDir` / `resumeJobId` child argv is `--session-dir <resolved> --continue`/`-c` (Pi `continueRecent`), not dir-only `SessionManager.create`. Fresh spawn still creates without `-c`. `sessionDir` surfaced in `pstack_spawn` / `pstack_jobs` text+details. Verify/unit assert continue argv (fail on session-dir alone). PARITY Cap2 EQUIVALENT (local-Task) with continue language. Keeps p1 bg omit→true + inherit default-on.

## close-orch-p1

- Cap2 EQUIVALENT (local-Task) revision: `pstack_spawn` `resumeSessionDir` / `resumeJobId` (reuse `--session-dir`; fail closed; in-memory `sessionDir` on jobs; resume+ephemeral rejected); tool `background` omit→true + guidelines (sync = `background: false`); `inheritParentTools` default-on when `getActiveTools()` non-empty; poteto/orchestrate cite resume; swarm/arena framed as intentional sync gather (N× spawn for bg drain); PARITY row 2 IN list updated (no resume-deferred carve-out).

## close-orch-p0

- Promote PARITY capability **2** to **EQUIVALENT (local-Task)** per Architect contract: reframed MCP/history/session-job ceilings; poteto prefers `background: true` + `pstack_jobs` drain; swarm/arena concurrency docs → **8** (env default 8). Resume/job ledger remain P1 follow-on.


## 0.15.2-pi.0 (close-local-v3 Stage 2)

- Sticky: force `sendUserMessage(/skill:poteto-mode playbooks/<id>)` on match; persist sticky+matched playbook; restore on session_start → **EQUIVALENT (local-Pi-sticky)**
- Loop: `/pstack-loop status|list|stop`; zero double-fire coalesce E2E; babysit recipes → **EQUIVALENT (local-loop-composite)**
- Shipping: babysit defaults to concrete watchArgv+dynamic arm; `evaluateMergeGates` fixture matrix → **EQUIVALENT (local-gh)**
- Models: validated always-applied role inject; refuse invalid selectors at spawn → **EQUIVALENT (local-role-routing)**
- Recall: ranked merge of sessions+git+gh → **EQUIVALENT (local-recall)**
- Readonly: auto-arm `/pstack-readonly` on investigation sticky match; spawn readonly defaults → **EQUIVALENT (local-readonly)**
- Spawn: `inheritParentTools` passthrough; jobs polish (PARTIAL residuals: MCP/history/session-scoped jobs — **historical pre-reframe**; Cap2 later EQUIVALENT local-Task; MCP inherit = HOST ceiling N/A)
- Deslop: expanded patterns + `dryRun` (PARTIAL residuals: team-kit depth / HTTP-only UI / unslop pair)
- Extension tests: expanded `extensions/test/verify-local-partials.mjs`

## 0.15.2-pi.0 (close-local-v2 Stage 2)

- Sticky: playbook auto-match + inject matched steps / forced poteto routing (`sticky-playbook.ts` + `sticky-poteto.ts`)
- Spawn: default concurrency **8**; default `sessionMode=isolated` (`--session-dir`; document no parent MCP/history inheritance); persistOutput default-on for long/background; `pstack_jobs` cancel alias
- Loop: coalesce/maxFires/shutdown helpers unit-tested; babysit concrete `watchArgv` recipes
- Worktrees: swarm/arena **always isolate**; session_shutdown safe cleanup of empty/merged pstack trees; PARITY row 4 **EQUIVALENT (local-git)**
- Recall: `pstack_sessions` action=`recall` (sessions + git log + gh PRs)
- Deslop: `applySafe` exercised in verify; optional `autoApply` via `ui.confirm`
- Extension tests: expanded `extensions/test/verify-local-partials.mjs` (must PASS)

## 0.15.2-pi.0 (close-local-partials Stage 2)

- Sticky poteto: re-inject full poteto-mode skill body each turn (`extensions/sticky-poteto.ts`)
- Spawn: `PSTACK_MAX_CONCURRENCY` / `PSTACK_MAX_OUTPUT_BYTES`; `sessionMode` ephemeral|isolated; `persistOutput` truncate-to-disk; inheritance via `--append-system-prompt` + env
- `pstack_jobs`: honest session-scoped persistence across follow-ups (dies on session_shutdown)
- `pstack_loop` dynamic: coalesce settle+watcher (~2.5s) to prevent double-fire; babysit docs aligned
- Session readonly: `/pstack-readonly` strips write/edit/bash; investigation playbook arms it
- Models: refuse/map bare marketing slugs; setup writes provider/id when detectable; always-applied-like role inject
- Deslop: structured fix suggestions + `applySafe`; guides require pstack_deslop/unslop only
- why/reflect/investigation: Pi-local MCP/readonly truth (no Cursor Ask/mcps/ requirements)
- PARITY local scorecard updated (PARTIAL→↑ on sticky, spawn, loop, deslop, models, readonly)

## 0.15.2-pi.0 (close-partials Stage 2)

- Background children: `pstack_spawn` `background: true` detaches via job queue + completion follow-up; `pstack_jobs` list/status/await/abort
- `pstack_loop` `mode: dynamic` = settle+watcher composite (re-arms watcher); babysit/shipping recipes use it
- Playbooks (shipping/autopilot/orchestrate/…): Cursor cloud agent → working `pstack_spawn`+`pstack_worktree` fleets
- Auto-readonly for `comment-sicko` and `investigator` roles; investigation playbook mandates it
- `pstack_deslop` thickened: severity ranks + per-file samples on added lines
- `/setup-pstack` writes concrete skill-default slugs (detect preferred model when available)
- why-skill Ask-mode clauses → Pi readonly truth; README/PARITY honesty + 12-capability behavioral scorecard


## 0.15.2-pi.0 (harden-p0)

- Skill↔tool contract: drop Cursor-only spawn args from skills; document sync-await background; remove fake loop `dynamic` mode; unify models path to `pstack-models.json`
- Parallel isolation: swarm/arena auto-allocate unique worktrees (or require unique cwd); no shared parent dirty cwd for multi-writer
- Security: decision_log allowlisted under `cwd/.pi`; worktree name/base sanitize; ship/merge real gate check (fail closed); no `bash -lc` of model strings; readonly/judge = Pi builtins without bash
- Performance: clear settle timers before re-arm; global child concurrency cap 4; mid-stream output caps; worktree remove/prune + session cap 12
- Simplicity: `pstack_decision_log` aligned to show-me-your-work 6-column schema

## 0.15.2-pi.0 (gap pass)

- Added missing portable assets: `.gitignore`, `assets/logo.png`, `docs/guide/images/*` (6 jpgs)
- Benny twin extension: `pstack_benny_wake`, `/setup-benny`, `/benny-triage`, `/benny-repro`
- Path retarget: `.cursor` → `.pi` in Benny pack, guide skill paths, worktree-audit sessions
- Guide overnight/recipes: `/loop` → `pstack_loop` twin wording
- PARITY.md now covers all 124 inventory rows (103 ported / 20 rewritten / 1 deferred)
- NOTICE updated; physical impossibilities only (marketplace, cloud VMs, Automations bus, full IDE control-ui, Grok Bot cards)


## 0.15.2-pi.0

- Initial native Pi package from Cursor pstack v0.15.2 (100% skill/playbook/agent file parity).
- All 47 skills + 23 playbooks + references/scripts adapted (Task → pstack_spawn/swarm/arena).
- Extensions (implemented, not stub-only):
  - `pstack_spawn`, `pstack_swarm`, `pstack_arena`, `pstack_worktree`
  - `pstack_loop` (/loop twin), `pstack_deslop`, `pstack_control_cli`, `pstack_control_ui`
  - `pstack_sessions` (recall), `pstack_babysit`, `pstack_ship` (gh-only)
  - `pstack_decision_log`, sticky `/poteto-mode`, `/setup-pstack`
- Agents: poteto-agent + comment-sicko via spawn roles.
- Benny retained under `automations/benny/` as manual twin (separate package next).
- Docs guide + PARITY.md matrix for every upstream artifact.
