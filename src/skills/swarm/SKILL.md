---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

## Start

Put one task per phase in the task list before launching anything (`pstack_plan` action `add`, or `custom` when no plan is open).

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Pick the worker model from the `swarm workers` entry in `pstack-models.json`, which `mode: "swarm"` uses. If the file is missing, it is `claude-opus-5-5` at `high`. An `auto` or `inherit-parent` entry runs the workers on the parent model. If `pstack_delegate` reports the model unavailable, pass the default as `model` and say so. If the default is unavailable too, pass the closest available model of the same family (`pi --list-models` lists them). For a model race, name each arm's model up front, one `models` entry per arm. Pick each subagent's reasoning level for the job, per the Subagents section of the **poteto-mode** skill.
4. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Start all N workers in one `pstack_delegate` call with `mode: "swarm"`, one task per worker, `role: "general-purpose"`, `readOnly: false` so each works in its own worktree, and the step 3 model, which runs them in parallel. Leave out `readOnly: false` only when the worker just reads the user's checkout.

When a worker must start from a non-default pushed branch, pass it as `base`.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with a result table, issue one-liners, gaps or dropouts, and the race rule when used.
