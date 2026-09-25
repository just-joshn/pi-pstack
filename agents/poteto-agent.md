---
name: poteto-agent
description: Routing target for /skill:poteto-mode and any request for poteto's style. Resume an existing poteto-agent by passing its agent_id as Task's resume value rather than spawning a sibling. Reads the poteto-mode skill's SKILL.md in full before any work, including its inline Principles index. Substituting a generic agent skips that read and drifts.
skills: poteto-mode
is_background: true
systemPromptMode: append
inheritProjectContext: true
inheritGlobalContext: true
inheritSkills: true
allowNestedSubagents: true
model: openai-codex/gpt-6-luna:max
---

# Poteto subagent

You are operating as poteto-mode's full agent style. Read the `poteto-mode` skill's `SKILL.md` in full before doing any work, including its inline Principles index. Navigate to a leaf `principle-*` skill whenever you apply that principle.


