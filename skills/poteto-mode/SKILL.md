---
name: poteto-mode
description: "The main engineering workflow router. Use when: Start any nontrivial engineering task; explicitly attach the skill or use it as a Custom Mode."
disable-model-invocation: true
---

# poteto-mode

The receiving Pi session owns execution. Restate the goal, name the smallest change and acceptance predicate, then select a playbook by its trigger using `pstack_catalog` with action `routes`. Call `pstack_plan` with action `start`, the selected route ID and goal. It loads the playbook and creates ordered tasks. For ambiguous, broad, cross-cutting or unattended work select `figure-it-out` instead of forcing a match. Use `pstack_plan` to start, update and finish tasks with evidence; do not mark a task done merely because a worker says so.

Read the specific principle skill before using it; name the decision it changed. Use architect for boundary changes, swarm for independent work, arena for competing designs, interrogate for disputed changes, unslop for prose, technical-writing for docs, no-comments before review, deslop before commit, control-ui or control-cli on the matching real interface, benchmark-checklist before trusting numbers and show-me-your-work for extended work. Use `pstack_delegate` for fresh direct workers. Never let a delegate become the playbook coordinator. Do not run all relationships unconditionally. Respect the user's explicit scope and approval boundaries. In a persistent session, a new task gets a new route. Read the route file in full; the graph is not the execution order.

## Conditional relationships

These are catalog references, not a mandatory call sequence. Read related instructions with `pstack_catalog` action `node` when the condition applies.

- `models`: reads role choices. When choosing a delegate model
- `agent-poteto`: direct delegate. For direct Task calls, unless routed skill sets its own type
- `worker`: kickoff contract. Each Task or Project worker starts by reading worker.md
- `principles`: trigger index. Read applicable leaf files before using the principle
- `playbooks`: selects playbook. After matching the task; receiving chat owns the steps
- `figure-it-out`: large or unmatched. When a narrower playbook does not fit
- `architect`: boundary change. When changing a function boundary
- `swarm`: fan-out. When splitting independent work
- `arena`: bakeoff. When comparing competing designs
- `interrogate`: contested design. When an important decision needs adversarial proof
- `unslop`: prose. When writing prose or replies
- `technical-writing`: docs and PRs. When writing docs or PR descriptions
- `no-comments`: before review. When preparing a diff for review
- `kit-deslop`: before commit. Direct Team Kit dependency
- `kit-control-ui`: ship UI or IDE. Direct Team Kit dependency; only when this is the real surface
- `kit-control-cli`: ship CLI / TUI. Direct Team Kit dependency; only when this is the real surface
- `benchmark-checklist`: measured number. Before trusting a measured result
- `show-me-your-work`: long run. When work is unattended or long
- `team-kit`: uses named skills. External conditional dependencies; not the entire kit
- `delegates`: delegate contract. Direct delegates read worker.md and the router
- `pb-investigation`: routes when matched. Question about mechanics, motivation or a recommendation.
- `pb-bug-fix`: routes when matched. A real defect or regression.
- `pb-perf-issue`: routes when matched. Latency, throughput or another measured slowdown.
- `pb-hillclimb`: routes when matched. Sustained scientific improvement toward a fixed metric target.
- `pb-runtime-forensics`: routes when matched. Leak, idle CPU spin or visual glitch.
- `pb-trace-forensics`: routes when matched. A trace, heap snapshot or profiling artifact.
- `pb-feature`: routes when matched. A new feature or changed behavior.
- `pb-refactoring`: routes when matched. A structural change without behavior change.
- `pb-prototype`: routes when matched. A design or empirical fork that can be settled by running something.
- `pb-visual-parity`: routes when matched. Matching two visual implementations or a migration baseline.
- `pb-authoring-a-skill`: routes when matched. A new or modified SKILL.md.
- `pb-eval`: routes when matched. Comparing variants of a skill or prompt.
- `pb-babysit`: routes when matched. PR conflicts, comments or red CI.
- `pb-shipping`: routes when matched. Explicit authorization to land a stack.
- `pb-autonomous-run`: routes when matched. A long task with a checkable exit condition.
- `pb-autopilot-full`: routes when matched. Authorized queue of independently landable PRs.
- `pb-autopilot-stack`: routes when matched. Work queue where the operator owns landing.
- `pb-session-pickup`: routes when matched. Taking over or resuming an interrupted run.
- `pb-pause-safely`: routes when matched. Pausing or handling impending context compaction.
- `pb-multi-phase-plan`: routes when matched. Large change spanning phases or stacked PRs.
- `pb-worktree-cleanup`: routes when matched. Merged or abandoned worktrees and simulator clutter.
- `pb-opening-a-pr`: routes when matched. At the end of an applicable delivery playbook.

<!-- Generated by scripts/generate.py from scripts/catalog-source.json. Edit the source, then run `python3 scripts/generate.py`. -->
