---
name: create-skill
description: >-
  Interactively create or edit a Pi skill (SKILL.md plus optional scripts, references, and assets)
  following Pi's skills documentation and the Agent Skills specification. Use when the user wants to
  create, scaffold, draft, test, or tune a skill, runs /skill:create-skill, or another skill hands
  off authoring to create-skill.
metadata:
  short-description: Create a new Pi skill
---

# Create Skill

Interactively gather requirements from the user and create a working Pi skill on disk. Pi's skills documentation is authoritative: `docs/skills.md` in the installed Pi package (`$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")/docs/skills.md`, or search for it under `$PI_CODING_AGENT_DIR/install/`). Read it before the first skill you write in a session.

## Step 1: Gather information

Ask the user the following questions **one at a time**. Use the `questionnaire` tool for the multiple-choice ones (scope, invocation), and plain chat for free text. When the questionnaire reports no UI, ask in chat.

1. **Skill name.** Ask the user to type a name. Lowercase letters (a-z), digits (0-9), and hyphens (-) only. No leading, trailing, or consecutive hyphens. At most 64 characters (e.g. `deploy-k8s`). Validate the name before proceeding.
2. **Scope.** Present the user with these options:
   - **Project** (Recommended inside a git repo): `<repo-root>/.pi/skills/<name>/SKILL.md`. Available only in this repo, shareable with teammates. Project skills need project trust.
   - **Project, portable**: `<repo-root>/.agents/skills/<name>/SKILL.md`. Also read by other Agent Skills harnesses.
   - **User**: `$PI_CODING_AGENT_DIR/skills/<name>/SKILL.md` in Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`). Available in all projects.
   - Default to **Project** if inside a git repo, otherwise **User**.
3. **What it should do.** Ask the user to describe the workflow, paste an example prompt they keep repeating, or explain the task the skill should automate.
4. **Invocation.** Ask whether the model may load it automatically, or only through `/skill:<name>`. The explicit-only choice sets `disable-model-invocation: true`, which hides it from the system prompt.

When another skill hands you a draft, a tuning request, or an edit, skip the questions it already answers.

## Step 2: Draft the description

Write a `description` frontmatter value (at most 1024 characters) that includes:

- What the skill does (1-2 sentences).
- When it applies: trigger phrases and keywords, so Pi routes to it. Avoid vague descriptions such as "Helps with PDFs".
- The command name (e.g. "Use when the user runs /skill:deploy-k8s").

Show the drafted description to the user and let them approve or edit it.

## Step 3: Create the directory

```bash
mkdir -p <SKILL_DIR>
```

Where `<SKILL_DIR>` is the scope path from Step 1 without `SKILL.md`. Use an absolute path.

If the skill needs helper scripts, also create `<SKILL_DIR>/scripts/`. For reference docs, `<SKILL_DIR>/references/`. For templates and static files, `<SKILL_DIR>/assets/`.

## Step 4: Write SKILL.md

Create `<SKILL_DIR>/SKILL.md` in this exact format:

```
---
name: <skill-name>
description: <the description from Step 2>
---

<markdown body with direct instructions, steps, code blocks>
```

Rules from the specification:

- `name` matches the directory name.
- Use only the specification's frontmatter fields: `name`, `description`, `license`, `compatibility`, `metadata` (a key-value map), `allowed-tools`, and `disable-model-invocation`. Put anything harness-specific (display names, icons, reminders) under `metadata`.
- Keep `description` one YAML scalar. Quote it, or use `>-` with indented continuation lines, when punctuation or wrapping requires it.
- Refer to bundled files by paths relative to the skill directory. Pi tells the model where the skill lives.
- Keep the body short and move detail into `references/` files that the body names, so it loads only when needed.

For best practices when writing the markdown body, read `../skill-design-principles/SKILL.md`. Do not copy those rules into the new skill. Use them as guiding principles.

Write any supporting files (scripts, references, assets) as needed.

## Step 5: Test and iterate

For a structural skill (fixed steps, a script, a checkable output), write 2-3 realistic test prompts. A test run executes the skill for real, so run it only against a throwaway copy, such as a fresh cloud Task worktree. Never run it in the user's working tree. Run each prompt in a fresh Task, for example `Task({ description: "Test the skill", prompt: "/skill:<name> <prompt>", subagent_type: "generalPurpose", environment: "cloud", cloud_base_branch: "origin/<branch>" })` when delegation is authorized, or `pi --print --no-session "/skill:<name> <prompt>"` with the scratch copy as the working directory. Fetch the named branch first. Compare the output to what the skill promises, fix the skill, and rerun. Skip this for subjective skills.

For a description-tuning request, write 5 prompts that should trigger the skill and 5 near-misses that should not. Check routing with `pi --print --no-session --no-tools "<prompt>. Do not act. Reply only with the names of the skills you would load."` so nothing executes, and tighten the description until the split is clean.

## Step 6: Verify and confirm

1. Read `<SKILL_DIR>/SKILL.md` back to verify the file was written correctly.
2. Check discovery in a fresh process without executing the skill: `pi --print --no-session --no-tools "/skill:<skill-name> Do not act. Reply only LOADED." 2>&1 | head -40`, run from a directory where the skill's scope applies. `--no-tools` keeps the check from touching files. Look for warnings about an invalid name, a missing or overlong description, or a name collision, and for an unknown-command reply. Tell the user to run `/reload` to pick it up in the current session.
3. Tell the user the skill is ready and how to use it:
   - Command: `/skill:<skill-name>`, optionally followed by a request.
   - Automatic: Pi loads it when the description matches the task, unless `disable-model-invocation: true` is set.

## Guidelines

- Keep the SKILL.md body focused and actionable. It is a prompt for the agent, not documentation.
- The `description` field is critical. It controls automatic loading. Be specific with trigger words.
- Prefer referencing existing CLI tools over writing custom scripts.
- Do NOT skip creating the directory. The file will fail to save without it.
- Always use absolute paths when creating files to avoid writing to the wrong location.
- Share several skills through a Pi package (`docs/packages.md`) rather than copying directories by hand.
