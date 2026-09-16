---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Fan out N parallel workers with `pstack_swarm` (local, sync gather). They may cover separate slices, race the same brief, or mix both. The parent waits, aggregates, and returns one report.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Set N from the user or derive it from the shape. N is total workers; the Pi concurrency cap is 8, and `pstack_swarm` batches a larger N in waves up to that cap.
4. Pick the worker model from `swarm workers` in `~/.pi/agent/pstack-models.json` when present. Otherwise use `grok-4.6-fast-xhigh`. For a model race, name each arm's model up front.
5. Give each worker its own writable output when it writes. Multi-writer runs must not share the parent dirty cwd: omit `cwd` so `pstack_swarm` allocates one worktree per writer, or pass a unique `cwd` per worker.

## Phase B: Fan out

Call `pstack_swarm` with every worker brief in one message (intentional sync gather; for detached drain use N× `pstack_spawn` + `pstack_jobs`).

When a worker must start from a non-default pushed branch, pass a `cwd` holding that branch (each worker gets its own worktree).

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

Keep a compact result table, one-line evidenced issues, and explicit gaps or dropouts.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
