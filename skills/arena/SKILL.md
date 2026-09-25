---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /skill:arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Loading this skill authorizes the Task calls it prescribes.

Fan out N parallel attempts at the same task. Read every candidate end to end. Pick the strongest as the base. Graft the best ideas from the others into it. Verify the synthesized result. One arena settles one decision. Settle follow-up forks while grafting rather than opening a nested arena.

## Start

Open a todo list with one entry per phase before launching anything. On Pi, use the `todo` tool.

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Phase A: Frame

The N candidates will receive the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric. State what success looks like for *this* task, then turn it into 3-6 concrete gradeable criteria. The rubric is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. Cursor source wording: Use the `arena runners` line in the `rules/pstack-models.mdc` rule. On Pi, use that matching role line from the pstack models block in AGENTS.md in Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). If the block or that line is missing, default to one each on `anthropic/claude-opus-5-5:max`, `openai-codex/gpt-5.6-sol:max`, and `anthropic/claude-sonnet-5:xhigh`. An `inherit-parent` or `auto` entry in this line or the cross-judge line means the parent model, so omit `model`. If Task rejects a configured entry, use its family's Pi default and say so. Families go by prefix (`claude-*`, `gpt-*`, `grok-*`). Claude and Grok use the Anthropic defaults; GPT uses the OpenAI Codex default. With no family match, use `anthropic/claude-opus-5-5:max`. If Task rejects a default, use the closest valid model of that provider family from its error message. Spawn at least one candidate per configured entry, so a three-entry list is three candidates. When the user names a count or names the alternatives ("two alternatives", "try A and B"), that wins: run that many candidates and give each one its own direction in the brief, so candidates that share a model do not converge on one shape. Assign distinct directions the same way whenever two entries share a model, as every `inherit-parent` entry does, so one round yields structurally distinct candidates. Spawn more when the arena covers multiple design directions. Same model N times when the work is generation-bound rather than judgment-sensitive.
4. Assign output paths. `<slug>` is the task slug plus a short unique suffix (for example the first 8 characters of the run id or `$(date +%s)`), so two arenas never share a directory. Each candidate writes to its own location: a managed worktree for code or `/tmp/arena-<slug>/candidate-<n>/` for the artifact and rationale. On Pi, `environment: "cloud"` creates the worktree from a named `cloud_base_branch`. Report each worktree path and branch, per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

Spawn all N subagents in one message with `run_in_background: true`. Give each Task the task, shared-grounding path, output path, and instructions to produce the artifact and a short rationale. Set `subagent_type: "poteto-agent"` when poteto-mode is active, and `subagent_type: "generalPurpose"` otherwise. Give each Task a distinct description and `output` path under `/tmp/arena-<slug>/candidate-<n>/`. For code candidates, set `environment: "cloud"` and a named `cloud_base_branch`. Fetch the branch first. Commit or stash changes in the source checkout before launching cloud tasks.

Each rationale names the alternatives the candidate considered and what it rejected.

If a candidate fails to produce output, proceed with N-1 and note the dropout in the synthesis record.

## Phase C: Cross-judge

After all Phase B candidates complete, choose one model from the `arena cross-judge pool` line in the same `AGENTS.md` block. If the block or that line is missing, choose from `anthropic/claude-opus-5-5:max`, `openai-codex/gpt-5.6-sol:max`, and `anthropic/claude-sonnet-5:xhigh`. Prefer a different model family from the parent's. Spawn one judge with `subagent_type: "generalPurpose"` and `readonly: true`. If the configured value is `inherit-parent` or `auto`, omit `model`. The judge sees the rubric and candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with the parent's reading in Phase D, not with candidates. Don't spawn the judge while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking.

Score each candidate against the rubric criterion by criterion, not on holistic feel. Compare against the cross-judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base on which candidate a future maintainer can extend most easily without breaking invariants. Prefer the cleaner boundary or smaller API when two feel tied, per the Laziness Protocol.

Record the pick and the reason in a short synthesis note alongside the base artifact, including the cross-judge's verdict.

## Phase E: Graft

Walk each losing candidate once more and identify what is worth porting into the base. The signal is usually one or two things per candidate, not most of it.

Fold each graft in by hand, per the **redesign-from-first-principles** principle skill. Don't paste mechanically. The result has to remain coherent under one mental model.

Record what was grafted, from which candidate, and what was rejected and why.

When N candidates converge on the same shape, that is a strong agreement signal. Note the convergence in the record and ship the consensus shape. No graft is needed. When N candidates wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

The synthesized artifact has to hold up under the same scrutiny as any other output, per the **prove-it-works** principle skill.

If verification surfaces a problem the arena did not catch, either Phase A was wrong (re-frame and re-run) or one candidate caught it and you missed the graft (go back to Phase E). Don't paper over.

## Outputs

One synthesized artifact. One short synthesis note alongside, naming the base, the grafts (with source candidate), the rejections, the dropouts if any, and the verification result.
