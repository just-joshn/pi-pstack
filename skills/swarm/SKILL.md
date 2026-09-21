---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Fan out N parallel workers. They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is the total number of workers to spawn, not a concurrency limit.
4. Pick the worker model from `swarm workers` in the pstack model rule (`~/.pi/agent/AGENTS.md`, written by `/setup-pstack`) when present. Otherwise use your fastest strong coding model. For a model race, name each arm's model up front.
5. Give each worker its own writable output when it writes.

## Phase B: Fan out

Spawn all N workers in one parallel subagent call (the `tasks` array), each entry `agent: "worker"` with the configured `model`. Workers run on this machine, isolated in their own context windows. When parallel workers would collide on the same checkout, give each its own git worktree and pass its path as the worker's `cwd`.

When a worker must start from a non-default pushed branch, create a worktree for that branch first and pass its path as the worker's `cwd`.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps. No cross-judge and no grafting. Swarm is coverage and racing. Arena is synthesis by merging.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
