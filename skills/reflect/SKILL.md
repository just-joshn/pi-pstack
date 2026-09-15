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

The parent finds its own transcript file before fanning out. The system prompt names the active workspace's Pi session transcripts directory. Use that path. Do not glob across `Pi session store (do not glob unrelated sessions)`. That crosses workspace boundaries and reads private chats from unrelated projects.

```bash
ls -t ~/.pi/agent/sessions/*.jsonl ~/.pi/agent/sessions/*/*.jsonl 2>/dev/null | head -10
# Prefer pstack_sessions tool when available; Cursor ~/.cursor/.../agent-transcripts is legacy-only.
```

Three transcript layouts: legacy flat (`<id>.jsonl`), current nested (`<id>/<id>.jsonl`), and subagent (`<parent>/subagents/<child>.jsonl`).

For each candidate, read the first JSONL line and check that `message.content[0].text` contains the conversation's opening user prompt. Take the matching path. If no path resolves, write a tight digest of the session and pass that instead.

### 2. Spawn three reviewers in parallel

One message, three `pstack_spawn` calls, `role: general via pstack_spawn`, explicit `model:` on each, agent mode (`readonly: false`). Reviewers may need MCP tools for context lookups. Pi `readonly` only clips builtins (`read,grep,find,ls`) — it does not strip MCP. Prefer readonly false with an explicit no-write brief when MCP is required.

| Lens | `model` | Prompt template |
|---|---|---|
| Judgment | your configured reflect-judgment model (default `claude-fable-5-1-thinking-max`) | `references/judgment-reviewer.md` |
| Tooling | your configured reflect-tooling model (default `gpt-5.6-sol-max`) | `references/tooling-reviewer.md` |
| Divergent | your configured reflect-judgment model (default `claude-fable-5-1-thinking-max`) | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the `Task` response body.

### 3. Synthesize

One `pstack_spawn` call, `role: general via pstack_spawn`, using your configured reflect-judgment model (default `claude-fable-5-1-thinking-max`), agent mode (`readonly: false`). The synthesizer's quality check includes spot-verifying citations, which can require MCP tools. Pi `readonly` only clips builtins. Use `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. The synthesizer returns a structured Accepted / Rejected / Backlog list.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. See the **encode-lessons-in-structure** principle skill.

### 5. Apply

Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval. The user picks which subset to apply and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

Backlog items file to whatever devex / backlog tracker your team uses automatically. Only the Accepted list waits for approval.

For each approved Accepted item, follow the Routing field exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to Pi skill authoring (write SKILL.md per Agent Skills standard; no Cursor create-skill) and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to Pi skill authoring and run its description-optimization loop.
- `new skill via create-skill: <kebab-name>`: hand creation to Pi skill authoring. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done. Skip this step if it doesn't.

### 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
