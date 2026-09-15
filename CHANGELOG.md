# Changelog

## 0.15.2-pi.0 (close-local-v3 Stage 2)

- Sticky: force `sendUserMessage(/skill:poteto-mode playbooks/<id>)` on match; persist sticky+matched playbook; restore on session_start → **EQUIVALENT (local-Pi-sticky)**
- Loop: `/pstack-loop status|list|stop`; zero double-fire coalesce E2E; babysit recipes → **EQUIVALENT (local-loop-composite)**
- Shipping: babysit defaults to concrete watchArgv+dynamic arm; `evaluateMergeGates` fixture matrix → **EQUIVALENT (local-gh)**
- Models: validated always-applied role inject; refuse invalid selectors at spawn → **EQUIVALENT (local-role-routing)**
- Recall: ranked merge of sessions+git+gh → **EQUIVALENT (local-recall)**
- Readonly: auto-arm `/pstack-readonly` on investigation sticky match; spawn readonly defaults → **EQUIVALENT (local-readonly)**
- Spawn: `inheritParentTools` passthrough; jobs polish (PARTIAL residuals: MCP/history/session-scoped jobs)
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
