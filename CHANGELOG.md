# Changelog

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
