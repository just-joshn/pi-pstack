Context from /var/folders/11/m_kwnqr97632l_cjt0mhytvh0000gn/T/tmp.K7ZZEQ0ONo/AGENTS.md

<!-- pstack-models:begin -->
## pstack

poteto-mode reminder. New task? Playbook match or rigor needed -> read `/var/folders/11/m_kwnqr97632l_cjt0mhytvh0000gn/T/tmp.b08aVoImvG/skills/poteto-mode/SKILL.md` in full and follow it, exactly as if the user had typed /skill:poteto-mode, before any other tool call. Plain-language requests count: a PR or stack to check on, get green, babysit, ship, or land; autopilot, orchestrate, or "run until" work; a plan, bug, feature, refactor, perf problem, or eval. A single direct instruction (run this command, start this job, answer this quick question) is not a new task. A `/skill:<name>` the user typed is that task's playbook: seed and follow that skill's own steps, under poteto-mode's principles and reply rules, and do not wrap it in another playbook. Inside a Task child, follow your brief and load poteto-mode only if you are a poteto-agent or the brief says so. Casual turn or user opts out -> don't.

Standing delegation authorization. The operator authorizes Task delegation whenever a loaded pstack skill, playbook, or agent file prescribes it, with the fan-out it names. Launch the Task fan-out the skill prescribes instead of doing that work in the parent.

pstack model configuration, which overrides skill defaults. One line per role. Delete a line to fall back to the skill default.
`inherit-parent` or `auto` as a value: the role runs on the parent model (omit `model` on Task). Alias entries in a panel list still count toward their fan-out.

```text
# budget: small (medium reasoning)
feature, refactoring: openai-codex/gpt-6-luna:medium
bug-fix: openai-codex/gpt-6-luna:medium
perf-issue: openai-codex/gpt-6-luna:medium
hillclimb: openai-codex/gpt-6-luna:medium
judgment and prose: openai-codex/gpt-6-luna:medium
hardest tasks: openai-codex/gpt-6-luna:medium
how explorer: openai-codex/gpt-6-luna:medium
how explainer: openai-codex/gpt-6-luna:medium
why investigators: openai-codex/gpt-6-luna:medium
why synthesizer: openai-codex/gpt-6-luna:medium
reflect tooling: openai-codex/gpt-6-luna:medium
reflect judgment, divergent, synthesizer: openai-codex/gpt-6-luna:medium
arena runners: openai-codex/gpt-6-luna:medium, openai-codex/gpt-6-luna:medium, anthropic/claude-opus-5-5:medium
arena cross-judge pool: openai-codex/gpt-6-luna:medium, anthropic/claude-opus-5-5:medium
swarm workers: openai-codex/gpt-6-luna:medium
architect runners: openai-codex/gpt-6-luna:medium, openai-codex/gpt-6-luna:medium, anthropic/claude-opus-5-5:medium
interrogate reviewers: openai-codex/gpt-6-luna:medium, openai-codex/gpt-6-luna:medium, anthropic/claude-opus-5-5:medium
```
<!-- pstack-models:end -->


You are a pstack delegate. Follow your brief exactly. It names the scope, output shape, and files to read. Report evidence, not intent. Spawn Task subagents only for fan-out your brief names.