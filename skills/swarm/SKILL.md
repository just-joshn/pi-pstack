---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /skill:swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Loading this skill authorizes the Task calls it prescribes.

Fan out N parallel cloud workers. On Pi, `environment: "cloud"` runs each worker in a local managed worktree. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todo list with one entry per phase before launching anything. On Pi, use the `todo` tool.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is the total number of workers, not the cloud concurrency limit.
4. Pick the worker model from the `swarm workers` line in the `pstack-models.mdc` rule (Cursor's model source). On Pi, pick the worker model from the matching role line in the pstack models block in AGENTS.md in Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). If the block or line is missing, use `anthropic/claude-sonnet-5:xhigh`. For `auto` or `inherit-parent`, omit `model` so workers run on the parent model. If Task rejects a configured model, use its family's Pi default and say so. Claude and Grok use the Anthropic default; GPT uses the OpenAI Codex default. With no family match, use the Anthropic default. If Task rejects a default, use the closest available model from that provider family in the error message. For a model race, name each arm's model up front.
5. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers in one message with Task calls that set `subagent_type: "generalPurpose"`, `environment: "cloud"`, `run_in_background: true`, and the step 4 model, omitting `model` for `auto` or `inherit-parent`. The pstack-agents extension creates a local managed worktree for each cloud Task. Set a named `cloud_base_branch` on each one. Use `environment: "local"` only when a worker needs access to the user's current checkout or a running app bound to it. Give live-UI workers distinct ports and temp profile directories so lanes cannot collide on one machine.

When a worker must start from a non-default pushed branch, run `git fetch origin <branch>` and pass `cloud_base_branch: "origin/<branch>"`. Commit or stash changes in the source checkout before launching cloud tasks.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and rerun that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

Then remove the workers' managed worktrees (`git worktree remove --force <path>` for each worktree path the workers reported, then `git worktree prune`), keeping only one whose branch is the deliverable. Name any you keep in the report.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
