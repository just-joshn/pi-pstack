---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes an always-applied rule that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
disable-model-invocation: true
---

# Setup pstack

Write the pstack model rule into `~/.pi/agent/AGENTS.md` (pi's global instructions, applied to every session, subagents included) as a managed block. It sets pstack's model per role.

## Steps

### 1. Detect available models

Run `pi --list-models` with the Bash tool. That is the dependable source. Models are addressed as `provider/model-id` (for example `anthropic/claude-opus-5`, `antigravity/gemini-3.1-pro`, `zai/glm-5.3`), optionally with a `:thinking` suffix (`anthropic/claude-opus-5:xhigh`) to pin the reasoning level for that role. If the command is unavailable, ask the user to paste the models they have access to. Never write a real model id you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected models.

### 2. Load current state

The default role-to-model mapping is the rule shape shown in step 5 below. If `~/.pi/agent/AGENTS.md` already contains a pstack block (between the `<!-- pstack:model-config start -->` and `<!-- pstack:model-config end -->` markers), read it and treat its `# budget` line and its role values as the current choices. Otherwise start from those defaults.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Ask with a numbered list of options rather than free text. Offer these four options with these exact labels, and name the current budget when the rule records one.

- `unlimited — keep max`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`, `auto`). `unlimited` leaves every effort as in that table. `large`, `medium`, and `small` set the thinking token of every real model id, panel entries included, to `xhigh`, `high`, or `medium`. The thinking token is the `:thinking` suffix. Effort ranks `max > xhigh > high > medium > low`, and an id with no suffix gets the suffix appended when the rewrite applies to it. If the result is not a detected model, use the same family's detected model with the highest effort at or below the target, else mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `small` turns `anthropic/claude-opus-5:max` into `anthropic/claude-opus-5:medium`, and a detected `zai/glm-5.3-highspeed:xhigh` into `zai/glm-5.3-highspeed:medium` when only that form exists.

**(c) Show the roles and confirm.** Show every role with its model, marking any real model id not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent session's model, which is how Auto users stay on Auto) as the options. Ask with a numbered list rather than free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real model id written must be in the detected set. `inherit-parent` and `auto` always pass. If a chosen real model is not available, stop and ask again.

### 5. Write the rule

Edit `~/.pi/agent/AGENTS.md`, replacing everything between the `<!-- pstack:model-config start -->` and `<!-- pstack:model-config end -->` markers (create the file and markers if missing) and leaving the rest of the file untouched, so re-runs stay idempotent. The block carries a `# budget` line with the chosen label and its target effort, and one line per role, using the same labels poteto-mode uses. Shape (values shown are examples, write the ones you detected in step 1):

```
<!-- pstack:model-config start -->
# pstack model configuration. One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent session's model (omit the subagent call's `model`). Alias entries in a panel list still count toward its fan-out.
# budget: unlimited (max)
feature, refactoring: anthropic/claude-opus-5:xhigh
bug-fix: anthropic/claude-opus-5:xhigh
perf-issue: anthropic/claude-opus-5:xhigh
hillclimb: anthropic/claude-opus-5:xhigh
judgment and prose: anthropic/claude-opus-5:max
hardest tasks: anthropic/claude-opus-5:max
how explorer: anthropic/claude-opus-5:xhigh
how explainer: anthropic/claude-opus-5:max
why investigators: anthropic/claude-opus-5:xhigh
why synthesizer: anthropic/claude-opus-5:max
reflect tooling: antigravity/gemini-3.1-pro:max
reflect judgment, divergent, synthesizer: anthropic/claude-opus-5:max
arena runners: anthropic/claude-opus-5:max, antigravity/gemini-3.1-pro:max, zai/glm-5.3:xhigh, deepseek/deepseek-v4-pro:xhigh
arena cross-judge pool: anthropic/claude-opus-5:max, antigravity/gemini-3.1-pro:max, zai/glm-5.3:xhigh, deepseek/deepseek-v4-pro:xhigh
swarm workers: anthropic/claude-opus-5:xhigh
architect runners: anthropic/claude-opus-5:max, antigravity/gemini-3.1-pro:max, zai/glm-5.3:xhigh, deepseek/deepseek-v4-pro:xhigh
interrogate reviewers: anthropic/claude-opus-5:max, antigravity/gemini-3.1-pro:max, zai/glm-5.3:xhigh, deepseek/deepseek-v4-pro:xhigh
<!-- pstack:model-config end -->
```

### 6. Confirm

Tell the user the rule was written and that it applies to new sessions (run `/reload` or restart pi to pick it up in the current one). Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke it (`/skill:create-verification-skill`, or `/create-verification-skill` with the pstack slash aliases installed). On no, move on without pushing.
