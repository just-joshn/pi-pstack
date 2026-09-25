---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Loading this skill authorizes the Task calls it prescribes.

Mine the current conversation for durable learnings, then route them into skill edits.

## When to invoke

Invoke when the user says "reflect" or "/skill:reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the active transcript

The parent finds its own transcript file before fanning out. Pi names it in `$PI_SESSION_FILE`. Use that path. Do not glob across Cursor projects. On Pi, keep the active workspace boundary at `~/.pi/agent/sessions/*/` in Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). That crosses workspace boundaries and reads private chats from unrelated projects.

```bash
echo "$PI_SESSION_FILE"
ls -t "$(dirname "$PI_SESSION_FILE")"/*.jsonl 2>/dev/null | head -10
find "${PI_SESSION_FILE%.jsonl}" -name '*.jsonl' -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -10
```

Two transcript layouts: a top-level session (`<timestamp>_<id>.jsonl` in the workspace session directory) and its subagent sessions (`<session basename>/<run id>/run-<n>/session.jsonl`). When `PI_SUBAGENT_CHILD=1`, `$PI_SESSION_FILE` is this child's own `run-<n>/session.jsonl`. Review that file, and find the parent as the `<timestamp>_$PI_SUBAGENT_PARENT_SESSION.jsonl` file in the workspace sessions directory.

When `$PI_SESSION_FILE` is unset, check each candidate. Its first line is `{"type":"session",...,"cwd":...}`. Find the first `{"type":"message"}` line whose `message.role` is `user` and check that its text contains the conversation's opening user prompt. Take the matching path. If no path resolves, write a tight digest of the session and pass that instead.

### 2. Spawn three reviewers in parallel

In one message, launch the three reviewer Tasks with `subagent_type: "generalPurpose"`, `readonly: false`, and each `model` set as below. Reviewers need MCP or local CLI access for context lookups (tickets, chat threads, observability traces referenced in the transcript). Read-only Task calls strip MCP access. Reviewers return findings in the Task response body.

Each reviewer and the synthesizer name a role line in the pstack models block in `~/.pi/agent/AGENTS.md` and a default. Set `model` to that line's value, or to the default if the block or line is missing. Omit `model` when the value is `auto` or `inherit-parent`. If Task rejects a configured model, use the default and say so. If Task rejects the default, use the closest valid model of the same provider family from its error message.

| Lens | Role line | Default `model` | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `anthropic/claude-opus-5-5:max` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `openai-codex/gpt-5.6-sol:max` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `anthropic/claude-opus-5-5:max` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in the `Task` response body.

### 3. Synthesize

Launch one Task with `subagent_type: "generalPurpose"`, `readonly: false`, and the `reflect judgment, divergent, synthesizer` model (default `anthropic/claude-opus-5-5:max`). The synthesizer's quality check includes spot-verifying citations, which can require MCP or CLI access. Read-only Task calls strip MCP access. Use `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. The synthesizer returns a structured Accepted / Rejected / Backlog list.

### 4. Structural enforcement check

Sanity-check the synthesizer's Accepted list. For any item that would be enforced more reliably by a lint rule, script, metadata flag, or runtime check, move it from Accepted to Backlog. See the **encode-lessons-in-structure** principle skill.

### 5. Apply

Before applying any Accepted edit, present the synthesizer's full Accepted/Rejected/Backlog output to the user and wait for explicit approval. The user picks which subset to apply and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

Backlog items file to whatever devex / backlog tracker your team uses automatically. Only the Accepted list waits for approval. On Pi, your team's tracker is the one the operator named, in this conversation or as a `backlog tracker:` line in `~/.pi/agent/AGENTS.md` or the project's `AGENTS.md`, outside the pstack models block so `/skill:setup-pstack` keeps it (for example `backlog tracker: gh issue create -R acme/devex` or `backlog tracker: linear, team DEVX`). File there without asking. With none named, file nowhere. Never infer a tracker from git remotes, skill paths, or the repo that publishes this Pi port. List each Backlog item in the summary under **Backlog, not filed**, followed by the one `backlog tracker:` line that would enable filing.

For each approved Accepted item, follow the Routing field exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): parent does directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the **create-skill** skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to `create-skill` and run its description-optimization loop.
- `new skill via create-skill: <kebab-name>`: hand creation to `create-skill`. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done. Skip this step if it doesn't.

### 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each. With no named tracker, **Backlog, not filed**: one line each, then the `backlog tracker:` line that would enable filing.
- Dropped: one line per rejected finding + reason from the synthesizer.
