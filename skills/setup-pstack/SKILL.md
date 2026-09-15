---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Detects your available models and writes ~/.pi/agent/pstack-models.json that overrides the skill defaults. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Prefer the `/setup-pstack` extension command when available. It writes `~/.pi/agent/pstack-models.json`.

If the command is unavailable, write that JSON yourself.

## Steps

### 1. Detect available models

Enumerate model selectors as `provider/id` from this Pi session (`/model`, `ctx.modelRegistry`, or the user's configured providers). Never write a selector you have not confirmed. Aliases `inherit-parent` and `auto` are always valid (role runs on the parent chat model).

### 2. Load current state

If `~/.pi/agent/pstack-models.json` or project `.pi/pstack-models.json` exists, treat it as current. Otherwise start from inherit-parent defaults.

### 3. Budget, map, and confirm

**(a) Ask for a budget** via chat or Pi select/confirm:

- `unlimited — keep max`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it** to effort tokens on real slugs when the user chose large/medium/small. Leave `inherit-parent` / `auto` unchanged.

**(c) Show every role** and confirm. Panel roles are arrays (one child per entry).

### 4. Validate

Every real `provider/id` must be available. `inherit-parent` and `auto` always pass.

### 5. Write the config

Write `~/.pi/agent/pstack-models.json` (user-level; do not commit). Shape:

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
    "arena runners": ["inherit-parent", "inherit-parent", "inherit-parent", "inherit-parent"],
    "arena cross-judge pool": ["inherit-parent"],
    "swarm workers": "inherit-parent",
    "architect runners": ["inherit-parent", "inherit-parent", "inherit-parent", "inherit-parent"],
    "interrogate reviewers": ["inherit-parent", "inherit-parent", "inherit-parent", "inherit-parent"]
  }
}
```

Replace `inherit-parent` with real `provider/id` selectors the user chose.

### 6. Confirm

Tell the user the file was written and applies to new turns. Re-running updates it.

### 7. Offer a verification skill (optional)

If the project has no verify harness, offer once: generate one with `/skill:create-verification-skill`.
