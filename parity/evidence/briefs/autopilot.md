# Autopilot: user-perspective test of autopilot-full and autopilot-stack on the live packaged install

You are a tester acting as the operator. Drive two real interactive Pi sessions in tmux and judge only what the operator sees plus the files and GitHub state Pi produces. Build your harness with the **control-cli** skill (`~/.pi/agent/pstack/pi-pstack/skills/control-cli/SKILL.md`). Do not fix anything. Report.

## Setup (exactly)

- Pi under test: the operator's live install in `~/.pi/agent`, which loads pstack from the package at `~/.pi/agent/pstack/pi-pstack` (commit `dea1f43`). Use Pi's configured default model; do not pass `--model`.
- Environment: start every Pi under test with every `PI_*` and every `PSTACK_AGENTS_*` variable removed (you are a Task child and have `PSTACK_AGENTS_DEPTH` set; the Pi under test must not inherit it). Start the tmux server from a clean environment (`env -u ... tmux ...` or `tmux -L <socket>` with `update-environment` cleared) and prove it: in each session, the first thing Pi runs for you shows `PSTACK_AGENTS_DEPTH` empty (ask Pi to run `echo "D=[$PSTACK_AGENTS_DEPTH]"` before the case prompt, and record the screen).
- Workspaces: two fresh clones of `just-joshn/pstack-pi-e2e` at `main` under `$TMPDIR`, one per case. `bun install --frozen-lockfile` in each.
- CI: the coordinator runs a local CI poster that sets a `local-ci/test` commit status on every open PR head within about two minutes. Do not run your own. If a PR head has no status after 10 minutes, record it.
- Evidence: `~/.pi/agent/pstack/pi-pstack/parity/evidence/autopilot/<case>/` (screens at each checkpoint, `timeline.tsv` with UTC timestamps, copies of the Pi session JSONL and each run's `status.json` and `request.json` from the case's `pstack-agents/` run store, never worktrees, and `gh pr view --json number,state,headRefName,baseRefName,headRefOid,mergedAt,statusCheckRollup` snapshots). Final report: `.../autopilot/report.md`.
- Forbidden: any GitHub write outside branches and PRs whose head starts with `ux5-` in `just-joshn/pstack-pi-e2e`; PR #9; anything in `just-joshn/pi-pstack`; edits in `~/.pi/agent` except the evidence directory; killing processes you did not start.
- Time box: 3 hours from the first case prompt. Run both cases in parallel.

## Operator rules

Type only the case prompt, `go` when a plan asks for it, and answers to questions Pi asks. Answer as a reasonable operator: take the recommended option; refuse anything irreversible outside the scratch repo. Do not nudge. If nothing observable changes (screen, run store, GitHub) for 45 minutes, record a stall, then type `status?` once and record that nudge.

## Cases

**full.** Type: `full autopilot: add a removeTodo(id) function to the store that removes one todo by id and returns true if it existed. Use branch prefix ux5-full-.`

**stack.** Type: `autopilot-stack: queue: (1) add a 'clear-done' CLI command that removes completed todos; (2) add a 'rename <id> <title>' CLI command. State the plan first. Use branch prefix ux5-stack-.` Type `go` after Pi states its plan.

Judge each case step by step against its playbook, both the Pi copy (`~/.pi/agent/pstack/pi-pstack/skills/poteto-mode/playbooks/autopilot-full.md`, `autopilot-stack.md`) and the official copy (`~/.pi/agent/pstack/pi-pstack/parity/upstream/0.15.5/pstack/skills/poteto-mode/playbooks/`). Read both in full first and cite step numbers. At minimum check:

- full: a goal is armed; one background owner Task per PR (`poteto-agent`, `environment: "cloud"`, from the run's `request.json`); a ready PR within about 20 minutes; the root verifies the code-ready head with the swarm lanes the playbook names; the owner merges only after a clean verdict and a green `local-ci/test`, without a nudge; the goal completes after the merge; any post-merge step the playbook names.
- stack: the plan is stated and Pi waits for `go`; each queue item becomes its own PR with its own owner; the second PR's base is the first PR's branch; each round is verified as the playbook says; the stack is left unmerged for the operator.
- both: no subagent dies unexpectedly (a run `status.json` with `failed` or `stopped` that nobody asked for); completion notices arrive once; no Unknown-agent or unavailable-tool errors.

## Cleanup (after the report data is captured)

In each Pi session, type `stop every background task, shell, and loop you started, then confirm`, and verify their run statuses are terminal. Quit each Pi. Confirm with `ps` that no `runner.mjs` process whose run directory belongs to your case sessions remains. Snapshot, then close any unmerged `ux5-` PRs and delete `ux5-` remote branches. Leave merged commits on `main` in place.

## Report

`report.md`: per case a table `step | expected (Pi + official citation) | observed (evidence path) | PASS/ISSUE/INCOMPLETE`, then findings ranked by severity with evidence, then time and cost. Your final reply: the report path, the per-case verdicts, and the ranked findings.
