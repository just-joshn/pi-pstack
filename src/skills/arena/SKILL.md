---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Put one task per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) in the task list before launching anything (`pstack_plan` action `add`, or `custom` when no plan is open).

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners from the `arena runners` entries in `pstack-models.json`, by default `claude-fable-5-2` at `high`, `claude-opus-5-5` at `high`, and `gemini-4-neon` at `xhigh`. An `auto` or `inherit-parent` entry is the parent model. If `pstack_delegate` reports a model unavailable, pass `models` with the nearest available model of the same family in that seat, or without the seat, keep at least two runners, and say so. Families go by prefix, and the longest match wins: `claude-fable-*`, `claude-*`, and `gemini-*`. Any other model's family is its ID's text before the first hyphen. Add seats to `models` for multiple design directions, and repeat one model when the work is generation-bound, not judgment-sensitive. Pick each subagent's reasoning level per the Subagents section of the **poteto-mode** skill.
4. Give each candidate its own output location (a git worktree, which `readOnly: false` gives each runner; outside a git repository, `git init` a scratch one at `/tmp/arena-<slug>/` first), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

Start all N runners in one `pstack_delegate` call (`mode: "arena"`, the task, and the `rubric`, which only the judge sees), which runs them in parallel. The task carries the path to the shared grounding and instructions to produce the artifact in the runner's worktree, its own output path, with a short rationale naming the alternatives it considered and what it rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, the same `pstack_delegate` call runs one read-only judge from the `arena cross-judge pool` entries in `pstack-models.json`, by default `claude-opus-5-5` at `high` and `gemini-4-neon` at `xhigh`. The judge is never from the parent's vendor, and Fable counts as Claude for that check, so the call uses the first available entry from another vendor. The pool holds no `auto` or `inherit-parent` entry, because that is the parent model. With no usable entry, the call skips the judge and its `judgment` says so, and you say so too. The judge scores each candidate, by its anonymous transcript label, on each rubric criterion and recommends a base, in the `judgment` you compare against during Phase D.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge when Phase C ran one. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict or that Phase C skipped the judge, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.
