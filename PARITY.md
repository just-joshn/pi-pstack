# PARITY.md — Cursor pstack v0.15.2 → pi-pstack

Generated against local cache `/workspace/pstack-raw` (plugin.json 0.15.2) + inventory `/workspace/pstack-pi-parity-inventory.md` (124 rows).

Status legend:

- **ported** — content present; bindings adapted to Pi (`read`/`write`/`edit`/`bash`, `pstack_*`)
- **rewritten** — Pi-native twin replacing a Cursor-only mechanism
- **deferred** — physically impossible on Pi; closest twin noted (must still ship twin)

## Summary counts

| Status | Count |
|---|---:|
| ported | 103 |
| rewritten | 20 |
| deferred | 1 |
| MISSING | 0 |
| **Total inventory rows** | **124** |

| Artifact class | Upstream | In pi-pstack |
|---|---:|---:|
| Skill directories (SKILL.md) | 47 | 47 |
| poteto-mode playbooks | 23 | 23 |
| Agents | 2 | 2 (as prompts + pstack_spawn roles) |
| Docs guide pages | 11 | 11 + images/ |
| Benny automation pack | present | rewritten twin (skills + pstack_benny_wake) |
| assets/logo.png | present | present |
| .gitignore | present | present |
| .cursor-plugin | present | deferred → package.json `pi` |


## Behavioral scorecard (12 capabilities)

Honest runtime parity vs Cursor pstack host behavior (not artifact presence). Legend: **EQUIVALENT** | **PARTIAL** | **NOT**.

| # | Capability | Behavioral | Notes (Stage 2 close-partials) |
|---|---|---|---|
| 1 | poteto-mode sticky + playbook routing | PARTIAL | Sticky session flag + soft prompt; playbooks use Pi recipes (`pstack_spawn`/`worktree`) |
| 2 | Task / subagent → spawn / swarm / arena | PARTIAL | Real local children; **background detach + `pstack_jobs`**; no cloud VMs; cap 4 |
| 3 | /loop → pstack_loop | PARTIAL | **`dynamic` = settle+watcher composite** (+ interval/settle/watcher) |
| 4 | worktrees isolation | PARTIAL | Real `pstack_worktree` + swarm/arena auto-isolation; not cloud/IDE UX |
| 5 | shipping / babysit (gh) | PARTIAL | Real `pstack_babysit`/`pstack_ship`; playbooks mandate local verify fleets |
| 6 | deslop / control companions | PARTIAL | Deslop: severity + samples; control_ui HTTP-only unless browser MCP |
| 7 | model role routing | PARTIAL | `/setup-pstack` writes **concrete skill defaults** (detect slug when possible) |
| 8 | recall | PARTIAL | `pstack_sessions` over Pi session corpus (not Cursor transcripts) |
| 9 | make-bot-ui | NOT | Wake file/webhook twin only; no Grok Bot `update_state`/secret cards |
| 10 | Benny | NOT | Manual skills + `pstack_benny_wake`; no Automations Slack bus |
| 11 | Ask-mode / readonly semantics | PARTIAL | Tool allowlist twin; **comment-sicko + investigator auto-readonly**; no Ask/MCP-strip |
| 12 | Automations / cloud agents / marketplace | NOT | Local spawn+worktree twin only; marketplace/Automations/cloud VMs absent |

Artifact matrix below counts files on disk. Do not read “ported” as EQUIVALENT.

## Inventory status (all 124 rows)

| Inventory path | Status | On disk | Upstream class | Notes |
|---|---|---|---|---|
| `.cursor-plugin/plugin.json` | deferred | n/a (host) | must port/rewrite | Cursor marketplace host absent; twin = package.json `pi` manifest |
| `README.md` | ported | yes | portable as SKILL.md | present |
| `LICENSE` | ported | yes | portable as SKILL.md | present |
| `.gitignore` | ported | yes | portable as SKILL.md | present |
| `assets/logo.png` | ported | yes | portable as SKILL.md | static branding asset present |
| `agents/poteto-agent.md` | rewritten | yes | must port/rewrite | Spawn via pstack_spawn role=poteto-agent|comment-sicko |
| `agents/comment-sicko.md` | rewritten | yes | must port/rewrite | Spawn via pstack_spawn role=poteto-agent|comment-sicko |
| `automations/benny/README.md` | rewritten | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/FOR_AGENTS.md` | rewritten | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/templates/configuration.example.yaml` | rewritten | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/templates/triage-automation-prompt.md` | rewritten | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/templates/reproduce-automation-prompt.md` | rewritten | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/setup-benny/SKILL.md` | rewritten | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/triage-issue-reports/SKILL.md` | rewritten | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/reproduce-and-fix-issues/SKILL.md` | rewritten | yes | depends on cursor-team-kit | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/reproduce-and-fix-issues/references/control-adapter.md` | rewritten | yes | depends on cursor-team-kit | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/reproduce-and-fix-issues/references/feature-map.example.md` | rewritten | yes | portable as SKILL.md | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/reproduce-and-fix-issues/references/verify-existing-fix.md` | rewritten | yes | portable as SKILL.md | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/triage-issue-reports/references/routing.example.md` | rewritten | yes | portable as SKILL.md | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `docs/guide/README.md` | ported | yes | portable as SKILL.md | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/01-setup.md` | ported | yes | must port/rewrite | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/02-poteto-mode.md` | ported | yes | portable as SKILL.md | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/03-understand.md` | ported | yes | portable as SKILL.md | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/04-design.md` | ported | yes | must port/rewrite | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/05-build-and-clean.md` | ported | yes | depends on cursor-team-kit | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/06-verify-and-ship.md` | ported | yes | must port/rewrite | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/07-overnight.md` | ported | yes | must port/rewrite | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/08-principles.md` | ported | yes | portable as SKILL.md | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/09-make-it-yours.md` | ported | yes | must port/rewrite | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/10-recipes-and-pitfalls.md` | ported | yes | must port/rewrite | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `docs/guide/images/*` | ported | yes | portable as SKILL.md | Pi install paths; /loop→pstack_loop; .cursor/skills→.pi/skills |
| `skills/principle-attack-the-premise/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-boundary-discipline/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-build-the-lever/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-encode-lessons-in-structure/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-exhaust-the-design-space/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-experience-first/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-fix-root-causes/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-foundational-thinking/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-guard-the-context-window/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-laziness-protocol/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-make-operations-idempotent/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-minimize-reader-load/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-model-the-domain/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-never-block-on-the-human/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-outcome-oriented-execution/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-prove-it-works/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-redesign-from-first-principles/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-separate-before-serializing-shared-state/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-sequence-verifiable-units/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-subtract-before-you-add/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-test-behavior-not-implementation/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/principle-type-system-discipline/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/SKILL.md` | ported | yes | must port/rewrite | bindings → pstack_spawn/swarm/arena |
| `skills/setup-pstack/SKILL.md` | rewritten | yes | must port/rewrite | /setup-pstack → ~/.pi/agent/pstack-models.json |
| `skills/swarm/SKILL.md` | ported | yes | must port/rewrite | pstack_swarm; cloud env → local+worktree (PARTIAL infra) |
| `skills/arena/SKILL.md` | ported | yes | must port/rewrite | bindings → pstack_spawn/swarm/arena |
| `skills/architect/SKILL.md` | ported | yes | must port/rewrite | bindings → pstack_spawn/swarm/arena |
| `skills/how/SKILL.md` | ported | yes | must port/rewrite | bindings → pstack_spawn/swarm/arena |
| `skills/why/SKILL.md` | ported | yes | must port/rewrite | bindings → pstack_spawn/swarm/arena |
| `skills/interrogate/SKILL.md` | ported | yes | must port/rewrite | bindings → pstack_spawn/swarm/arena |
| `skills/reflect/SKILL.md` | ported | yes | must port/rewrite | bindings → pstack_spawn/swarm/arena |
| `skills/no-comments/SKILL.md` | ported | yes | must port/rewrite | bindings → pstack_spawn/swarm/arena |
| `skills/blast-radius/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/figure-it-out/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/create-verification-skill/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/maintain-verification-skill/SKILL.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/tdd/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/unslop/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/bro/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/teach/SKILL.md` | ported | yes | must port/rewrite | bindings → pstack_spawn/swarm/arena |
| `skills/technical-writing/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/typescript-best-practices/SKILL.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/show-me-your-work/SKILL.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/show-me-your-work/scripts/log.sh` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/show-me-your-work/references/decision-log-template.tsv` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/recall/SKILL.md` | rewritten | yes | must port/rewrite | pstack_sessions + SessionManager; no ~/.cursor agent-transcripts |
| `skills/automate-me/SKILL.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/make-bot-ui/SKILL.md` | rewritten | yes | must port/rewrite | webhook/wake-file twin; no Grok Bot update_state |
| `skills/poteto-mode/playbooks/investigation.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/playbooks/bug-fix.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/poteto-mode/playbooks/perf-issue.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/playbooks/hillclimb.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/poteto-mode/playbooks/runtime-forensics.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/playbooks/trace-forensics.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/playbooks/feature.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/poteto-mode/playbooks/refactoring.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/poteto-mode/playbooks/prototype.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/playbooks/visual-parity.md` | rewritten | yes | depends on cursor-team-kit | companion twins: pstack_deslop / pstack_control_cli / pstack_control_ui |
| `skills/poteto-mode/playbooks/authoring-a-skill.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/playbooks/eval.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/poteto-mode/playbooks/babysit.md` | ported | yes | must port/rewrite | pstack_loop + pstack_ship/pstack_babysit (gh) |
| `skills/poteto-mode/playbooks/shipping.md` | ported | yes | depends on cursor-team-kit | pstack_loop + pstack_ship/pstack_babysit (gh) |
| `skills/poteto-mode/playbooks/autonomous-run.md` | ported | yes | must port/rewrite | pstack_loop + pstack_ship/pstack_babysit (gh) |
| `skills/poteto-mode/playbooks/orchestrate.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/poteto-mode/playbooks/autopilot-full.md` | ported | yes | depends on cursor-team-kit | pstack_loop + pstack_ship/pstack_babysit (gh) |
| `skills/poteto-mode/playbooks/autopilot-stack.md` | ported | yes | depends on cursor-team-kit | pstack_loop + pstack_ship/pstack_babysit (gh) |
| `skills/poteto-mode/playbooks/session-pickup.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/poteto-mode/playbooks/pause-safely.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/playbooks/multi-phase-plan.md` | rewritten | yes | depends on cursor-team-kit | companion twins: pstack_deslop / pstack_control_cli / pstack_control_ui |
| `skills/poteto-mode/playbooks/worktree-cleanup.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/poteto-mode/playbooks/opening-a-pr.md` | rewritten | yes | depends on cursor-team-kit | companion twins: pstack_deslop / pstack_control_cli / pstack_control_ui |
| `skills/poteto-mode/references/bugbot-triage.md` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/poteto-mode/scripts/package.json` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/scripts/bootstrap.ts` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/scripts/check-plan.mjs` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/scripts/worktree-audit.sh` | ported | yes | must port/rewrite | retargeted transcripts → ~/.pi/agent/sessions (Cursor legacy fallback) |
| `skills/poteto-mode/scripts/orch/orch.ts` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/scripts/orch/store.ts` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/scripts/orch/orch.test.ts` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/poteto-mode/scripts/watch-pr/watch-pr` | ported | yes | must port/rewrite | retained; wired via pstack_babysit |
| `skills/poteto-mode/scripts/watch-pr/cli.ts` | ported | yes | portable as SKILL.md | retained; wired via pstack_babysit |
| `skills/poteto-mode/scripts/watch-pr/github.ts` | ported | yes | must port/rewrite | retained; wired via pstack_babysit |
| `skills/poteto-mode/scripts/watch-pr/policy.ts` | ported | yes | portable as SKILL.md | retained; wired via pstack_babysit |
| `skills/poteto-mode/scripts/watch-pr/render.ts` | ported | yes | portable as SKILL.md | retained; wired via pstack_babysit |
| `skills/poteto-mode/scripts/watch-pr/types.ts` | ported | yes | portable as SKILL.md | retained; wired via pstack_babysit |
| `skills/architect/references/*` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/how/references/*` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/interrogate/references/*` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/reflect/references/*` | ported | yes | must port/rewrite | present; Pi-adapted |
| `skills/create-verification-skill/references/feature-map-example/*` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/typescript-best-practices/references/patterns.md` | ported | yes | portable as SKILL.md | drop-in / light path tweaks |
| `skills/why/references/*` | ported | yes | must port/rewrite | present; Pi-adapted |

## Extensions runtime (pi-pstack)

| Module | Tools / commands | Status |
|---|---|---|
| extensions/index.ts | /poteto-mode, /poteto-mode-off, /pstack | rewritten |
| extensions/subagents | pstack_spawn, pstack_jobs (background detach) | rewritten |
| extensions/orchestration | pstack_swarm, pstack_arena | rewritten |
| extensions/models | /setup-pstack, role injection | rewritten |
| extensions/decision-log | pstack_decision_log | rewritten |
| extensions/worktree | pstack_worktree | rewritten |
| extensions/gates | /pstack-gates | rewritten |
| extensions/heartbeat | pstack_loop (interval|settle|watcher|dynamic), /pstack-loop | rewritten |
| extensions/companions | pstack_deslop (severity+samples), pstack_control_cli, pstack_control_ui, /deslop | rewritten |
| extensions/sessions | pstack_sessions | rewritten |
| extensions/shipping | pstack_babysit, pstack_ship | rewritten |
| extensions/benny | pstack_benny_wake, /setup-benny, /benny-triage, /benny-repro | rewritten |

## Remaining physical impossibilities (twins shipped)

1. **Cursor plugin marketplace / `.cursor-plugin`** — impossible on Pi. Twin: `package.json` `pi` manifest + `pi install`.
2. **Cursor cloud agent VMs** — no public Pi equivalent API. Twin: local `pstack_spawn` (`background` + `pstack_jobs`) + `pstack_worktree` fleets.
3. **Cursor Automations Slack bus** — no in-core Slack automation host. Twin: `pstack_benny_wake` + `pstack_loop` watcher + Benny skills under `automations/benny/`.
4. **Full Electron/IDE UI driving (control-ui)** — Pi is TUI-first. Twin: `pstack_control_ui` HTTP probe + optional browser MCP.
5. **Grok Bot `update_state` / secret-request cards** — Cursor-only. Twin: make-bot-ui wake file/webhook + env/file secrets.

No upstream skill directory or playbook is omitted from the package tree. MISSING count must be 0 for install-ready (assets/gitignore filled).
