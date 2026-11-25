### Authoring or modifying a skill

**You own the skill's voice.**

1. Follow Pi's skills guide (`docs/skills.md` in the `@earendil-works/pi-coding-agent` package), Pi's reference for authoring SKILL.md files. A skill is a directory holding `SKILL.md`, in `.pi/skills/` for a project or `~/.pi/agent/skills/` for the user.
2. Validate the skill: frontmatter has `name` and `description`, referenced files exist, cross-skill links resolve. Then confirm Pi loads it: `echo '{"type":"get_commands"}' | pi --mode rpc --offline --no-session --no-extensions --no-skills --no-prompt-templates --no-mcp --skill <skill-dir>` lists `skill:<name>` only when Pi accepted the file. The operator runs `/reload` to pick up the edit in an open session.
3. Test cases if structural. Skip if subjective.
4. Run **Opening a PR**.

When in doubt, delete. Keep only prose that changes a decision. Tell it to do the thing and skip the reason. Explain only when the rule is confusing without one. Match tone to scope. Point at structural sources (types, READMEs, config) per the **encode-lessons-in-structure** principle skill. Delegate to other skills by path. Don't restate. A workflow you keep hitting but isn't captured → propose a new skill.

**Reply:** summary of the skill, key design decisions, validation notes.
