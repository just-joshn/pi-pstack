---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes ~/.pi/agent/pstack-models.json that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Prefer the `/setup-pstack` extension command when it is available. It writes the file with concrete `provider/id` values when it can detect them. If the command is unavailable, write the file yourself following the same rules.

## Steps

### 1. Detect available models

Enumerate the model selectors (`provider/id`) this Pi session can pass to `pstack_spawn`. That is the dependable source. Use `/model`, `ctx.modelRegistry`, `PI_MODEL` / `PSTACK_DEFAULT_MODEL`, and the user's configured providers. If you cannot detect any, ask the user to paste the selectors they have access to. Never write a real selector you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected selectors, because the role then runs on the parent chat model.

Refuse bare marketing slugs (a name with no `provider/`). If you only know a Cursor marketing name, map it through the extension's known map or write `inherit-parent` until a real `provider/id` is confirmed.

### 2. Load current state

The default role-to-model mapping is the file shape shown in step 5 below. If `~/.pi/agent/pstack-models.json` or project `.pi/pstack-models.json` already exists, read it and treat its `budget` field and its role values as the current choices. Otherwise start from those defaults, preferring detected `provider/id` values over `inherit-parent` where you have confirmed one.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Ask in chat. Offer these four options with these exact labels, and name the current budget when the config records one.

- `unlimited — keep max`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`, `auto`). `unlimited` leaves every effort as in that table. `large`, `medium`, and `small` set the effort token of every real selector, panel entries included, to `xhigh`, `high`, or `medium`. The effort token is the last token, or the one before a trailing `fast`, on the ladder `max` > `xhigh` > `high` > `medium` > `low`. If the result is not a detected selector, use the same family's detected selector with the highest effort at or below the target, else mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `small` turns `anthropic/claude-opus-4-5` into `anthropic/claude-opus-4-5-medium` when that selector is detected.

**(c) Show the roles and confirm.** Show every role with its model, marking any real selector not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model, which is how Auto users stay on Auto) as the options. Ask in chat. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one child runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real selector written must be in the detected set. `inherit-parent` and `auto` always pass. If a chosen real selector is not available, stop and ask again.

### 5. Write the config

Write `~/.pi/agent/pstack-models.json` (user-level; do not commit it), with a `budget` value, a `version: 1` field, and one entry per role, using the same labels poteto-mode uses. Overwrite the whole file so re-runs stay idempotent. Shape (the example uses `inherit-parent` placeholders — write your confirmed `provider/id` values where you have them):

```json
{
  "version": 1,
  "budget": "unlimited (max)",
  "roles": {
    "feature, refactoring": "inherit-parent",
    "bug-fix": "inherit-parent",
    "perf-issue": "inherit-parent",
    "hillclimb": "inherit-parent",
    "judgment and prose": "inherit-parent",
    "hardest tasks": "inherit-parent",
    "how explorer": "inherit-parent",
    "how explainer": "inherit-parent",
    "why investigators": "inherit-parent",
    "why synthesizer": "inherit-parent",
    "reflect tooling": "inherit-parent",
    "reflect judgment, divergent, synthesizer": "inherit-parent",
    "arena runners": ["inherit-parent"],
    "arena cross-judge pool": ["inherit-parent"],
    "swarm workers": "inherit-parent",
    "architect runners": ["inherit-parent"],
    "interrogate reviewers": ["inherit-parent"]
  }
}
```

A role with no entry keeps its skill default. Re-running this skill replaces the file.

### 6. Confirm

Tell the user the config was written and that it applies to new turns (the parent sticky inject and every child's `resolveRoleModel` read it). Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /skill:create-verification-skill." On yes, invoke it. On no, move on without pushing.
