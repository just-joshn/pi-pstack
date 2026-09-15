# PARITY.md — Cursor pstack v0.15.2 → pi-pstack

Checked against upstream `cursor/plugins@c1c0a32` (`pstack/plugin.json` 0.15.2). Content parity is machine-verified: run `npm run parity:check`, see [`port/README.md`](./port/README.md).

Status legend:

- **ported** — content present; bindings adapted to Pi (`read`/`write`/`edit`/`bash`, `pstack_*`)
- **rewritten** — Pi-native twin replacing a Cursor-only mechanism
- **deferred** — physically impossible on Pi; closest twin noted (must still ship twin)

## Content parity (strict, machine-checked)

The ported tree is a pure function of upstream plus the declared bindings:

```
local file == apply(port/bindings/, upstream file)
```

`npm run parity:check` enforces it over all 153 upstream files under `skills/`, `agents/`, `automations/`, and `docs/`:

- 103 files byte-identical to upstream.
- 48 files differ only through declared bindings (each binding names the Cursor mechanism it replaces).
- 2 files are declared whole-mechanism overrides (`skills/make-bot-ui/SKILL.md`, `skills/setup-pstack/SKILL.md`); the override must list pins named upstream sections and the leftover scan rejects Cursor mechanisms. Overrides are hand-maintained and reviewed.
- 0 unmigrated Cursor mechanism tokens, 0 unknown `pstack_*` tool references, 0 dead `scripts/...` paths.

A file outside the binding table cannot drift: the checker fails on any byte it did not produce. Platform `name` frontmatter is a binding (`Poteto Mode` → `poteto-mode`, `Make Bot UI` → `make-bot-ui`); upstream display titles remain documentation.

## Summary counts

| Status | Count |
|---|---:|
| ported | 115 |
| rewritten | 8 |
| deferred | 1 |
| MISSING | 0 |
| **Total inventory rows** | **124** |

| Artifact class | Upstream | In pi-pstack |
|---|---:|---:|
| Skill directories (SKILL.md) | 47 | 47 |
| poteto-mode playbooks | 23 | 23 |
| Agents | 2 | 2 (as prompts + pstack_spawn roles) |
| Docs guide pages | 11 | 11 + images/ |
| Benny automation pack | present | ported (path + host bindings; Cursor Automations host out of scope) |
| assets/logo.png | present | present |
| .gitignore | present | present |
| .cursor-plugin | present | deferred → package.json `pi` |


## Behavioral scorecard (12 capabilities)

Honest runtime parity vs Cursor pstack host behavior (not artifact presence). Legend: **EQUIVALENT** | **PARTIAL** | **NOT**.
Bar: **Cursor CLI / local agent** semantics on Pi — not cloud VMs, marketplace, Automations/Slack, or Grok Bot cards.

| # | Capability | Behavioral | Notes (Stage 2 close-orch-p1) |
|---|---|---|---|
| 1 | poteto-mode sticky + playbook routing | **EQUIVALENT** (local-Pi-sticky) | **Local-scope criteria (post Verifier sticky fix):** (a) sticky stays armed via `appendEntry` + `session_start` restore; (b) matched playbook id persisted; (c) on match, `sendUserMessage(/skill:poteto-mode playbooks/<id> …)` force-invokes — on failure **notifies** and arms inject fallback (no silent empty-catch); (d) `before_agent_start` re-injects skill body + **full matched/restored playbook steps** (not a routing note only). **Not** Cursor host `mode:true` bit-identical. |
| 2 | Task / subagent → spawn / swarm / arena | **EQUIVALENT** (local-Task) | **Local-scope IN:** `resumeSessionDir` / `resumeJobId` → child argv `--session-dir <resolved> --continue`/`-c` (Pi `continueRecent`; **not** dir-only create); fail closed if missing; `sessionDir` surfaced in `pstack_spawn`/`pstack_jobs` text+details; background omit→true + guidelines (sync needs `background: false`); `inheritParentTools` default-on when `tools` unset and `getActiveTools()` non-empty (explicit `false` or `tools[]` overrides; readonly roles force `READONLY_TOOLS`); `pstack_jobs` list/status/await/abort|cancel within session; **MAX_CONCURRENCY** default **8** (shared spawn/swarm/arena; env `PSTACK_MAX_CONCURRENCY`); poteto prefers background + `pstack_jobs` drain; `sessionMode=isolated`; `persistOutput` on for bg/long; clean-context children; `pstack_swarm` / `pstack_arena` = intentional sync gather/barrier (EQUIVALENT local-gather; bg drain = N× `pstack_spawn`). **Certified ceilings (not blocking):** Pi has no first-party MCP — Cursor-local MCP inherit **N/A** (host ceiling); parent transcript inherit **N/A** — Cursor Subagents also start clean; session-scoped jobs (die on `session_shutdown`) = Cursor-local restart behavior — **not** a durable-daemon gap. |
| 3 | /loop → pstack_loop | **EQUIVALENT** (local-loop-composite) | **Local-scope criteria:** modes `interval|settle|watcher|dynamic` cover Cursor-local `/loop` babysit/shipping use cases; dynamic coalesce prevents double-fire (unit-tested); `/pstack-loop status|list|stop [id]|off|stop [id]|off`; babysit concrete `watchArgv` recipes + E2E coalesce script. ExtensionAPI twin ≠ native slash UX chrome — scored only as local-loop-composite. |
| 4 | worktrees isolation | **EQUIVALENT** (local-git) | Criteria met for **local git isolation**: real `git worktree` create/list/remove/prune; name/base sanitize; cap 12; **swarm/arena always isolate** (even N=1); **session_shutdown safe cleanup** of empty/merged `.pstack-worktrees` (dirty/unmerged skipped). Not cloud/IDE UX — scored only as local-git twin. |
| 5 | shipping / babysit (gh) | **EQUIVALENT** (local-gh) | **Local-scope criteria:** `pstack_babysit` + `pstack_ship` with fail-closed `evaluateMergeGates` (fixture matrix ≥8 cases); babysit defaults to concrete `watchArgv` recipe + `pstack_loop mode=dynamic` arm payload; gate-check before merge. Not Origin-first / cloud-verifier luxuries. |
| 6 | deslop / control companions | PARTIAL | `applySafe` + **`dryRun`** + expanded pattern set; optional `autoApply` via `ui.confirm`. **Residuals (≤3):** (1) pattern depth still thinner than cursor-team-kit `/deslop`; (2) `pstack_control_ui` is HTTP probe only (no Electron/IDE drive); (3) prose cleanup still pairs with `/skill:unslop` rather than a full team-kit workflow. |
| 7 | model role routing | **EQUIVALENT** (local-role-routing) | **Local-scope criteria:** `/setup-pstack` writes provider/id when detectable; sticky/session `before_agent_start` always injects **validated** role map; explicit invalid bare selectors **refused** at `pstack_spawn` (`allowFallbackToParent:false`); children resolve via `resolveRoleModel`. Storage is JSON (not Cursor `.mdc` rule file) — scored as local-role-routing only. |
| 8 | recall | **EQUIVALENT** (local-recall) | **Local-scope criteria:** `pstack_sessions` action=`recall` rebuilds topic context via **ranked merge** of Pi sessions + `git log` + `gh` PRs (when available) without Cursor transcripts. Completes local “rebuild topic context” workflow under Pi corpus. |
| 9 | make-bot-ui | NOT | Wake file/webhook twin only; no Grok Bot `update_state`/secret cards |
| 10 | Benny | NOT | Manual skills + `pstack_benny_wake`; no Automations Slack bus |
| 11 | Ask-mode / readonly semantics | **EQUIVALENT** (local-readonly) | **Local-scope criteria:** `/pstack-readonly` strips write/edit/bash; sticky investigation playbook **auto-arms** readonly; spawn `investigator`/`comment-sicko` auto-readonly allowlist; `tool_call` blocks writes (and mutating ship/worktree/deslop-apply). **Not** Cursor Ask-mode MCP-strip — scored as local-readonly only. |
| 12 | Automations / cloud agents / marketplace | NOT | Local spawn+worktree twin only; marketplace/Automations/cloud VMs absent |

**Verifier-aligned scorecard (close-orch-p1b / Cap2 true continue):** **EQUIVALENT** (local-scope): **1** sticky, **2** spawn/Task (local-Task), **3** loop, **4** worktrees, **5** shipping/babysit, **7** models, **8** recall, **11** readonly. **PARTIAL:** **6** deslop (≤3 residual bullets). Out-of-scope **NOT:** 9, 10, 12. Pi skill `name` frontmatter must be kebab-case (`poteto-mode`); Cursor display title `Poteto Mode` is host-only — invocation path `/poteto-mode` unchanged.

Never claim Cursor sticky-host / Ask-MCP / native `/loop` chrome / first-party MCP bit-identical.

**Content parity:** the ported tree is upstream + declared bindings, enforced by `npm run parity:check` (see “Content parity” above). Capability parity below is separate: it grades the Pi extension behavior, not the docs.

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
| `automations/benny/README.md` | ported (path + host bindings; Cursor Automations host out of scope) | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/FOR_AGENTS.md` | ported (path + host bindings; Cursor Automations host out of scope) | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/templates/configuration.example.yaml` | ported (path + host bindings; Cursor Automations host out of scope) | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/templates/triage-automation-prompt.md` | ported (path + host bindings; Cursor Automations host out of scope) | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/templates/reproduce-automation-prompt.md` | ported (path + host bindings; Cursor Automations host out of scope) | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/setup-benny/SKILL.md` | ported (path + host bindings; Cursor Automations host out of scope) | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/triage-issue-reports/SKILL.md` | ported (path bindings only; Cursor Automations host out of scope) | yes | must port/rewrite | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/reproduce-and-fix-issues/SKILL.md` | ported (path + host bindings; Cursor Automations host out of scope) | yes | depends on cursor-team-kit | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/reproduce-and-fix-issues/references/control-adapter.md` | ported (path bindings only; Cursor Automations host out of scope) | yes | depends on cursor-team-kit | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/reproduce-and-fix-issues/references/feature-map.example.md` | ported (path bindings only; Cursor Automations host out of scope) | yes | portable as SKILL.md | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/reproduce-and-fix-issues/references/verify-existing-fix.md` | ported (path bindings only; Cursor Automations host out of scope) | yes | portable as SKILL.md | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
| `automations/benny/skills/triage-issue-reports/references/routing.example.md` | ported (path bindings only; Cursor Automations host out of scope) | yes | portable as SKILL.md | Pi twin: skills under automations/benny + pstack_benny_wake /setup-benny;/benny-triage;/benny-repro + pstack_loop |
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
| `skills/swarm/SKILL.md` | ported | yes | must port/rewrite | pstack_swarm intentional sync gather (**EQUIVALENT** local-gather); cloud VM twin only via N× local `pstack_spawn`+worktree |
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
| extensions/index.ts | /poteto-mode sticky force-invoke+persist playbook, /pstack-readonly auto-arm investigation, /pstack | rewritten |
| extensions/subagents | pstack_spawn (resume `--session-dir`+`--continue`/`-c`, sessionDir in replies, background omit→true, inheritParentTools default-on, concurrency≥8, isolated, persistOutput), pstack_jobs list/status/await/cancel | rewritten |
| extensions/orchestration | pstack_swarm, pstack_arena (always isolate) | rewritten |
| extensions/models | /setup-pstack (provider/id), validated always-applied role inject, spawn refuse invalid | rewritten |
| extensions/decision-log | pstack_decision_log | rewritten |
| extensions/worktree | pstack_worktree + session_shutdown safe cleanup | rewritten |
| extensions/gates | /pstack-gates | rewritten |
| extensions/heartbeat | pstack_loop (interval/settle/watcher/dynamic+coalesce), /pstack-loop status|list|stop | rewritten |
| extensions/companions | pstack_deslop (applySafe+dryRun+expanded patterns), pstack_control_cli, pstack_control_ui, /deslop | rewritten |
| extensions/sessions | pstack_sessions (list/grep/recall ranked merge: sessions+git+gh) | rewritten |
| extensions/shipping | pstack_babysit (default watchArgv+dynamic), pstack_ship (gate matrix) | rewritten |
| extensions/benny | pstack_benny_wake, /setup-benny, /benny-triage, /benny-repro | rewritten |

## Remaining physical impossibilities (twins shipped)

1. **Cursor plugin marketplace / `.cursor-plugin`** — impossible on Pi. Twin: `package.json` `pi` manifest + `pi install`.
2. **Cursor cloud agent VMs** — no public Pi equivalent API. Twin: local `pstack_spawn` (`background` + `pstack_jobs`) + `pstack_worktree` fleets.
3. **Cursor Automations Slack bus** — no in-core Slack automation host. Twin: `pstack_benny_wake` + `pstack_loop` watcher + Benny skills under `automations/benny/`.
4. **Full Electron/IDE UI driving (control-ui)** — Pi is TUI-first. Twin: `pstack_control_ui` HTTP probe + optional browser MCP.
5. **Grok Bot `update_state` / secret-request cards** — Cursor-only. Twin: make-bot-ui wake file/webhook + env/file secrets.

No upstream skill directory or playbook is omitted from the package tree. MISSING count must be 0 for install-ready (assets/gitignore filled).
