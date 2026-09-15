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

If `~/.pi/agent/pstack-models.json` or project `.pi/pstack-models.json` exists, treat it as current. Otherwise start from concrete skill defaults (`grok-4.6-fast-xhigh` for code roles, `claude-fable-5-1-thinking-max` for judgment/prose), upgrading any detected `provider/id` from the session/env when available. Prefer real slugs over `inherit-parent`.

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
    "feature, refactoring": "grok-4.6-fast-xhigh",
    "bug-fix": "grok-4.6-fast-xhigh",
    "perf-issue": "grok-4.6-fast-xhigh",
    "hillclimb": "grok-4.6-fast-xhigh",
    "judgment and prose": "claude-fable-5-1-thinking-max",
    "hardest tasks": "claude-fable-5-1-thinking-max",
    "how explorer": "grok-4.6-fast-xhigh",
    "how explainer": "claude-fable-5-1-thinking-max",
    "why investigators": "grok-4.6-fast-xhigh",
    "why synthesizer": "claude-fable-5-1-thinking-max",
    "reflect tooling": "grok-4.6-fast-xhigh",
    "reflect judgment, divergent, synthesizer": "claude-fable-5-1-thinking-max",
    "arena runners": ["claude-fable-5-1-thinking-max", "gpt-5.6-sol-max", "grok-4.6-fast-xhigh", "claude-opus-5-thinking-xhigh"],
    "arena cross-judge pool": ["claude-fable-5-1-thinking-max"],
    "swarm workers": "grok-4.6-fast-xhigh",
    "architect runners": ["claude-fable-5-1-thinking-max", "gpt-5.6-sol-max", "grok-4.6-fast-xhigh", "claude-opus-5-thinking-xhigh"],
    "interrogate reviewers": ["claude-fable-5-1-thinking-max", "gpt-5.6-sol-max", "grok-4.6-fast-xhigh", "claude-opus-5-thinking-xhigh"]
  }
}
```

Replace any slug your account lacks with a confirmed `provider/id`, or `inherit-parent` / `auto` to follow the parent chat model.

### 6. Confirm

Tell the user the file was written and applies to new turns. Re-running updates it.

### 7. Offer a verification skill (optional)

If the project has no verify harness, offer once: generate one with `/skill:create-verification-skill`.
