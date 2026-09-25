# pi-pstack 0.15.5-pi.1: package the live port

Source of the port today: loose files under `~/.pi/agent` (skills, extensions, agents, `pstack/parity`, `pstack/pstack-agents`).
Target: this repo as one Pi package, installed with `pi install <path>`, following the Pi 0.87.1 docs
(`packages.md`, `extensions.md`, `skills.md`, `settings.md`). Local branch `pi-package-0.15.5`. No push, no PR.

## Done predicate

1. `node parity/check-parity.mjs` reports 0 problems and `node parity/full-audit.mjs` stays at or above the 98.896% floor, both reading this repo.
2. Unit tests and `tsc --noEmit` pass from a fresh `npm ci`.
3. `npm pack --dry-run` lists only manifest resources, the upstream `docs/`, `automations/`, and `assets/` (shipped for parity with the Cursor plugin), and README, LICENSE, and CHANGELOG. No extension tests, `parity/`, or `node_modules`.
4. `parity/lint-package.mjs` finds no absolute home paths and no `~/.pi/agent/{skills,extensions,agents}` references in shipped files.
5. In an empty `PI_CODING_AGENT_DIR` holding only auth plus `pi install <repo>`, the RPC `get_commands` inventory equals the baseline taken from the loose install, startup has no resource diagnostics, and the smoke suite passes: foreground and background Task, SubagentAwait, Shell and Await, `/goal`, `/loop`, questionnaire, todo, the poteto footer, guards inside children, named-skill injection, readonly reader.
6. The live `~/.pi/agent` runs on the package (loose copies moved to a backup), and the same smoke plus one focused autopilot run pass there.

## Rigor

High. The live switch changes the operator's daily Pi. Every step is reversible through the backup in `/tmp/pstack-pre-package`.

## Units, riskiest first

- U0. Harness. `parity/verify-package.sh` builds the isolated agent dir, installs a package path, and dumps the RPC inventory. Baseline is captured from the loose install first.
- U1. Spike the unknown. Does a Task child spawned from a package-installed extension load the package skills, the guard extension, and the bundled agents.
- U2. Codemod. `parity/build-from-live.mjs` copies the live resources into the repo and rewrites Pi paths to skill-relative or package-relative paths. It deletes the legacy runtime (`extensions/subagent`, `pstack-slash.ts`, `reviewer`, `worker`).
- U3. Runtime. pstack-agents finds bundled agents through `import.meta.url`, reads `extensions/pstack-agents.json` in the agent dir for model scope (the `sandbox.json` precedent in the official examples), and resolves guard paths inside the package.
- U4. Parity tooling moved into `parity/` and pointed at the repo. Lint added.
- U5. Manifest, dependencies (peer `*` for Pi packages and typebox, `commander` for skill scripts), tests, typecheck, pack.
- U6. Isolated smoke through the TUI harness by a tester lane.
- U7. Live switch, smoke, focused autopilot run.
- U8. README, CHANGELOG, PARITY, local commits.
