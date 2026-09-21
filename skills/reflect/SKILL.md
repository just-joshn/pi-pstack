---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

## When to invoke

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the active transcript

The parent finds its own transcript file before fanning out. pi stores sessions as JSONL under `~/.pi/agent/sessions/`, with this project's sessions in a directory named `--<path>--`, where `<path>` is the absolute working directory with the leading slash dropped and every remaining `/` replaced by `-` (so `/Users/you/proj` becomes `--Users-you-proj--`). Use that path. Do not glob across `~/.pi/agent/sessions/*/`. That crosses project boundaries and reads private chats from unrelated projects.

```bash
ls -t ~/.pi/agent/sessions/--"$(pwd | sed 's|^/||; s|/|-|g')"--/*.jsonl 2>/dev/null | head -10
```

pi sessions are flat `<timestamp>_<uuid>.jsonl` files; the newest one is the active session.

For each candidate, read the first lines and check that a `message` entry with `"role": "user"` contains the conversation's opening prompt. Take the matching path. If no path resolves, write a tight digest of the session and pass that instead.

### 2. Spawn three reviewers in parallel

One parallel subagent call, three `tasks` entries, `agent: "worker"`, explicit `model` on each, unrestricted tools. Reviewers need MCP access for context lookups (tickets, chat threads, observability traces referenced in the transcript); a restricted toolset strips MCPs.

| Lens | `model` | Prompt template |
|---|---|---|
| Judgment | your configured reflect-judgment model (default: your strongest reasoning model) | `references/judgment-reviewer.md` |
| Tooling | your configured reflect-tooling model (default: the strongest model from a different family) | `references/tooling-reviewer.md` |
| Divergent | your configured reflect-judgment model (default: your strongest reasoning model) | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the subagent result.

### 3. Synthesize

One subagent call, `agent: "worker"`, using your configured reflect-judgment model (default: your strongest reasoning model), unrestricted tools. The synthesizer's quality check includes spot-verifying citations, which can require MCP access; a restricted toolset strips MCPs. Use `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. The synthesizer returns a structured Accepted / Rejected / Backlog list.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. See the **encode-lessons-in-structure** principle skill.

### 5. Apply

Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval. The user picks which subset to apply and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

Backlog items file to whatever devex / backlog tracker your team uses automatically. Only the Accepted list waits for approval.

For each approved Accepted item, follow the Routing field exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): follow the **authoring-a-skill** playbook (`poteto-mode/playbooks/authoring-a-skill.md`) and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): follow that playbook's description-optimization loop.
- `new skill: <kebab-name>`: hand creation to that playbook. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done. Skip this step if it doesn't.

### 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
