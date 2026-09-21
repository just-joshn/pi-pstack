### Authoring or modifying a skill

**You own the skill's voice.**

1. Follow the pstack **authoring-a-skill** rules: this playbook (you are here), plus the pi Agent Skills format. Frontmatter is `name` and `description`, and pi's rules: `name` is lowercase letters, numbers, and hyphens, 1-64 chars; `description` up to 1024 chars describing what the skill does and when to use it.
2. Validate the skill: frontmatter has `name` and `description`, referenced files exist, cross-skill links resolve.
3. Test cases if structural. Skip if subjective.
4. Run **Opening a PR**.

When in doubt, delete. Keep only prose that changes a decision. Tell it to do the thing and skip the reason. Explain only when the rule is confusing without one. Match tone to scope. Point at structural sources (types, READMEs, config) per the **encode-lessons-in-structure** principle skill. Delegate to other skills by path. Don't restate. A workflow you keep hitting but isn't captured → propose a new skill.

**Reply:** summary of the skill, key design decisions, validation notes.
