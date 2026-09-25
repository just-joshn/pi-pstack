---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available Pi models and writes an always-loaded pstack block into AGENTS.md in Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) that overrides the skill defaults. Use for /skill:setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write the pstack block in `~/.pi/agent/AGENTS.md`. Pi loads that file into every session, which makes it the always-applied rule that sets pstack's model per role. The block also carries the poteto-mode reminder, since Pi has no sticky modes.

## Steps

### 1. Detect available models

Run `pi --list-models` to enumerate model ids available to Task. Every id is `<provider>/<id>`. A real value is one of those ids plus an optional thinking suffix, `:<level>`, where the level is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. If you cannot detect any models, ask the user to paste the ids they have access to. Never write an id you have not confirmed is available. The aliases `inherit-parent` and `auto` are valid model choices in the pstack block; omit `model` for either alias so Task uses the parent model.

### 2. Load current state

The default role-to-model mapping is the block shape shown in step 5 below. If `~/.pi/agent/AGENTS.md` already has a block between `<!-- pstack-models:begin -->` and `<!-- pstack-models:end -->`, read it and treat its `# budget` line and role values as the current choices. Also read an existing `~/.cursor/rules/pstack-models.mdc` once, if present, as a migration source for the user's role choices. Otherwise start from the defaults. A line whose role is not in step 5, such as the retired `how critics` role, is obsolete and should be dropped.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Use the `questionnaire` tool (ask in chat with lettered options when it has no UI) with these four options and these exact labels, and name the current budget when the block records one. When the questionnaire returns the answer, continue straight to (b) in the same turn. End the turn only when you fell back to asking in chat.

- `unlimited — keep max`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`, `auto`). `unlimited` leaves every thinking level as in that table. `large`, `medium`, and `small` set the thinking suffix of every real value, panel entries included, to `xhigh`, `high`, or `medium`. The ladder is `max` > `xhigh` > `high` > `medium` > `low` > `minimal` > `off`. A value with no suffix uses the model's default thinking level, so add the target suffix. Every detected Pi model accepts every suffix, and Pi clamps a level the provider does not support, so the id itself never changes. `inherit-parent` and `auto` do not change. So `small` turns `anthropic/claude-opus-5-5:max` into `anthropic/claude-opus-5-5:medium`, and `anthropic/claude-sonnet-5:xhigh` into `anthropic/claude-sonnet-5:medium`.

**(c) Show the roles and confirm.** Show every role with its model, marking any real model id not in the detected set as needing a choice. Also list each obsolete role line step 2 dropped. Ask with the `questionnaire` tool (or in chat, as above) whether to accept as-is or change specific roles, offering the detected ids plus `inherit-parent` and `auto` as the options. Both aliases mean the role runs on the parent model, so omit `model`. Continue in the same turn once the questionnaire answers. End the turn only for the chat fallback. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family (provider plus model line) differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real value written must be a detected id plus an optional valid suffix. `inherit-parent` and `auto` always pass. If a chosen id is not available, stop and ask again.

### 5. Write the block

Create `~/.pi/agent/AGENTS.md` if it is missing. Replace everything between the two markers with the new block, or append the block at the end when the markers are absent. Leave the rest of the file untouched, so re-runs stay idempotent. Resolve `../poteto-mode/SKILL.md` relative to this skill's directory, then replace `ABSOLUTE_PATH_TO_POTETO_MODE_SKILL` in the template with that absolute path before writing the block. Write it with a small script rather than by hand (principle-build-the-lever), then print the block back to confirm. Shape:

````markdown
<!-- pstack-models:begin -->
## pstack

poteto-mode reminder. New task? Playbook match or rigor needed -> read `ABSOLUTE_PATH_TO_POTETO_MODE_SKILL` in full and follow it, exactly as if the user had typed /skill:poteto-mode, before any other tool call. Plain-language requests count: a PR or stack to check on, get green, babysit, ship, or land; autopilot, orchestrate, or "run until" work; a plan, bug, feature, refactor, perf problem, or eval. A single direct instruction (run this command, start this job, answer this quick question) is not a new task. A `/skill:<name>` the user typed is that task's playbook: seed and follow that skill's own steps, under poteto-mode's principles and reply rules, and do not wrap it in another playbook. Inside a Task child, follow your brief and load poteto-mode only if you are a poteto-agent or the brief says so. Casual turn or user opts out -> don't.

Standing delegation authorization. The operator authorizes Task delegation whenever a loaded pstack skill, playbook, or agent file prescribes it, with the fan-out it names. Launch the Task fan-out the skill prescribes instead of doing that work in the parent.

pstack model configuration, which overrides skill defaults. One line per role. Delete a line to fall back to the skill default.
`inherit-parent` or `auto` as a value: the role runs on the parent session model (omit `model` on Task). Alias entries in a panel list still count toward its fan-out.

```text
# budget: unlimited (max)
feature, refactoring: anthropic/claude-sonnet-5:xhigh
bug-fix: anthropic/claude-sonnet-5:xhigh
perf-issue: anthropic/claude-sonnet-5:xhigh
hillclimb: anthropic/claude-sonnet-5:xhigh
judgment and prose: anthropic/claude-opus-5-5:max
hardest tasks: anthropic/claude-opus-5-5:max
how explorer: anthropic/claude-sonnet-5:xhigh
how explainer: anthropic/claude-opus-5-5:max
why investigators: anthropic/claude-sonnet-5:xhigh
why synthesizer: anthropic/claude-opus-5-5:max
reflect tooling: openai-codex/gpt-5.6-sol:max
reflect judgment, divergent, synthesizer: anthropic/claude-opus-5-5:max
arena runners: anthropic/claude-opus-5-5:max, openai-codex/gpt-5.6-sol:max, anthropic/claude-sonnet-5:xhigh
arena cross-judge pool: anthropic/claude-opus-5-5:max, openai-codex/gpt-5.6-sol:max, anthropic/claude-sonnet-5:xhigh
swarm workers: anthropic/claude-sonnet-5:xhigh
architect runners: anthropic/claude-opus-5-5:max, openai-codex/gpt-5.6-sol:max, anthropic/claude-sonnet-5:xhigh
interrogate reviewers: anthropic/claude-opus-5-5:max, openai-codex/gpt-5.6-sol:max, anthropic/claude-sonnet-5:xhigh
```
<!-- pstack-models:end -->
````

Then enforce it. In `~/.pi/agent/extensions/pstack-agents.json`, set `modelScope` to `{ "enforce": true, "allow": [...] }` so the file contains `{ "modelScope": { "enforce": true, "allow": [...] } }`, where the list is `"inherit"` plus every real id the block names, each written as `provider/id` without its `:<thinking>` suffix. Keep every other setting in the file. With that policy, a Task call that passes a model outside the configured set fails with a modelScope error instead of running on a model the user did not choose.

### 6. Confirm

Tell the user the block was written and that it applies to new sessions, or to this one after `/reload`. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill under `.pi/skills/` or `.agents/skills/`, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with `/skill:create-verification-skill`." On yes, read and follow `../create-verification-skill/SKILL.md`. On no, move on without pushing.
