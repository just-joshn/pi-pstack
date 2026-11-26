---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes pstack-models.json, which overrides the skill defaults for every worker. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write `pstack-models.json` in Pi's agent directory (`~/.pi/agent/`, or `$PI_CODING_AGENT_DIR`), the file `pstack_delegate` reads to set pstack's model per role. The operator can also type `/setup-pstack`, which asks the same questions in Pi's selection dialogs and writes the same file.

## Steps

### 1. Detect available models

Enumerate the models a worker can run on. `pi --list-models` prints each `provider` and `model`, and a worker's model is `<provider>/<model>`. That is the dependable source. A provider that an extension registers lists only when that extension loads, so when a model the user expects is missing, ask them to run `/setup-pstack show`, which lists exactly the models workers can use. If you cannot detect any, ask the user to paste the model IDs they have access to. Never write a real model you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected models.

### 2. Load current state

The default role-to-model mapping is the file shape shown in step 5 below. If `pstack-models.json` already exists, read it and treat its `budget` and its role values as the current choices. Otherwise start from those defaults. A role that is not in step 5, such as `hardest tasks`, `architect runners`, `reflect tooling`, or `why investigators`, is from a retired role. Drop it, because `pstack_delegate` refuses a file with a role it does not know.

Older versions of this package wrote `inherit-parent` for every role and left `arena cross-judge pool` empty. So a file whose every role is exactly that is an old default, not a set of choices. Each role takes its step 5 default. Tell the user which entries you replaced.

A file without `"defaults": 3` does not come from this setup, and `pstack_delegate` refuses it. Before step 3, replace these values:

- An `arena cross-judge pool` entry of `inherit-parent` or `auto` is dropped, because the pool takes only real models, and an alias is the parent's vendor.
- A `budget` that is not `large`, `medium`, or `small`, such as `unlimited`, becomes `large`, because no role runs above `xhigh`.
- A role whose value is one model rather than a list becomes a one-entry list. A role other than a panel (`arena runners`, `arena cross-judge pool`, `interrogate reviewers`) keeps only its first entry.

Every other value is the user's choice and stays, including every `inherit-parent` or `auto` value outside the judge pool. Tell the user which values you replaced.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Ask one multiple-choice question rather than free text. Offer these three options with these exact labels, and name the current budget when the file records one. With no file, say that `large` matches the skill defaults.

- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** Build the working table from the skill defaults, and on a re-run keep any role you changed by family, list, or alias (`inherit-parent`, `auto`). Families are the ones Phase A of the **arena** skill defines, so Fable is its own family. Each role has a target effort, which is its default's effort moved by the budget. `large` keeps it, `medium` lowers it one step, and `small` lowers it two steps, on the ladder `xhigh` > `high` > `medium` > `low`. No role runs above `xhigh`, and a target at the bottom of the ladder stays there. Most defaults are at `xhigh`, and each budget label names where those land. An entry is a model with no level, and `pstack_delegate` runs every model in the role, panel entries included, at the role's target, so the file records only the budget and the models. If a default model is not detected, use the closest detected model of the same family, else mark the role as needing a choice. `inherit-parent` and `auto` do not change. So `medium` runs `claude-opus-5-5` at `high` in a code role and at `medium` in `swarm workers`, and `small` runs them at `medium` and `low`. Fable 5.2 and Gemini have no other levels to pick, because the role sets the level. A Gemini 4 Neon entry in a panel role takes its own target, `xhigh` moved by the budget, so `large` runs it at `xhigh`, `medium` at `high`, and `small` at `medium`.

**(c) Show the roles and confirm.** Show every role with its model, marking any real model not in the detected set as needing a choice. Also list each entry step 2 dropped. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` (both mean: this role runs on the parent chat model) as the options. Ask with multiple-choice questions rather than free text. For panel roles (arena runners, interrogate reviewers) the value is a list of up to eight entries, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena runs one judge. It tries only values from a vendor other than the parent's, in list order, so order it by preference. Fable and the other Claude models are one vendor. An `inherit-parent` or `auto` value never judges, so the pool holds none. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Every real model written must be in the detected set. `inherit-parent` and `auto` always pass outside the judge pool. If a chosen real model is not available, stop and ask again.

### 5. Write the rule

Write `pstack-models.json` in Pi's agent directory with `"defaults": 3`, a `budget` with the chosen label, and one entry per role, using the same labels poteto-mode uses. Overwrite the whole file so re-runs stay idempotent. Shape, with each model under the provider that serves it:

```
{
  "defaults": 3,
  "budget": "large",
  "roles": {
    "feature, refactoring": ["anthropic/claude-opus-5-5"],
    "bug-fix": ["anthropic/claude-opus-5-5"],
    "perf-issue": ["anthropic/claude-opus-5-5"],
    "hillclimb": ["anthropic/claude-opus-5-5"],
    "judgment and prose": ["anthropic/claude-opus-5-5"],
    "arena runners": ["anthropic/claude-fable-5-2", "anthropic/claude-opus-5-5", "google/gemini-4-neon"],
    "arena cross-judge pool": ["anthropic/claude-opus-5-5", "google/gemini-4-neon"],
    "swarm workers": ["anthropic/claude-opus-5-5"],
    "interrogate reviewers": [
      "anthropic/claude-fable-5-2", "anthropic/claude-opus-5-5", "google/gemini-4-neon"
    ]
  }
}
```

### 6. Confirm

Tell the user the file was written and that the next worker any session starts uses it. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, follow the **create-verification-skill** skill (`../create-verification-skill/SKILL.md`, which this package installs). On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /create-formal-verification-skill." On yes, follow the **create-formal-verification-skill** skill (`../create-formal-verification-skill/SKILL.md`, which this package installs). On no, move on without pushing.
