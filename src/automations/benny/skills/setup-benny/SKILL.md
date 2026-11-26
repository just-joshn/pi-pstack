---
name: setup-benny
description: Configure Benny and prepare its triage and repro automations. Use when installing Benny or changing its Slack, tracker, repository, routing, control, model, or budget settings.
disable-model-invocation: true
---

# Set up Benny

Benny ships as a dormant automation pack inside pstack. The package's `pi.skills` exposes only pstack's normal skill root; this file and the two operational files are not slash skills.

The human enters setup by pointing Pi at the pack's `FOR_AGENTS.md`. The bootstrap flow copies the whole pack into the target repository, then reads this file directly at `.pi/automations/benny/skills/setup-benny/SKILL.md`.

Benny needs external configuration and two live automations. Each is a job file that pstack's job runner runs headless in Pi, and pstack's Slack watcher starts both for every new top-level report.

Do not create or update an automation until the user explicitly asks. Never put a secret value in package files, prompts, job files, or committed configuration.

## 1. Copy the pack and enable shared pstack skills

Do this before asking for Benny configuration and before running `/pstack-automation`.

Ask which repository will run the automations. The source pack is the directory containing `FOR_AGENTS.md`, at `<pstack>/src/automations/benny/` in the installed pstack package. The destination is `<target-repository>/.pi/automations/benny/`.

Merge the entire source pack into the destination:

1. Create the destination when it is absent.
2. Copy every source file to the same relative path.
3. Preserve destination-only files. Never delete unrelated files during install or refresh.
4. Keep user-owned configuration, feature maps, and routing maps outside the destination. Never overwrite them.
5. When an existing source-managed file differs, inspect the diff and merge without discarding local edits. If ownership is ambiguous, stop and ask before replacing it.
6. Verify that the destination contains `FOR_AGENTS.md`, this setup file, both operational files, their references, and the templates.

If this file is already being read from the target destination, treat the copy as complete and run the same verification before continuing.

Add pstack to the target repository's `.pi/settings.json`. If the file or `.pi` directory does not exist, create it.

Merge this entry into the existing JSON or JSONC:

```json
{
	"packages": ["npm:pi-pstack-workflow-kit"]
}
```

Preserve every unrelated top-level setting and every other package entry. If `packages` already lists `npm:pi-pstack-workflow-kit`, as a string or an object, leave that entry as it is. Preserve comments and valid JSONC syntax when the file uses JSONC. Validate the file after editing it.

Start a fresh agent rooted in the target project with `node <pstack>/src/jobs/check-benny.mjs <target-repository>`. It trusts the project for that one run and reports every skill below that did not resolve from project scope. Verify that these shared pstack skills resolve from project scope:

- `why`
- `tdd`
- `unslop`
- `principle-separate-before-serializing-shared-state`
- `principle-minimize-reader-load`
- `principle-guard-the-context-window`
- `principle-sequence-verifiable-units`
- `principle-fix-root-causes`
- `principle-prove-it-works`

Do not count a skill loaded from the current session or a user-scoped package. The check must show that a fresh agent in the target repository receives pstack through project settings.

If project package installation is unavailable or any shared dependency does not resolve, stop and explain the failure.

The Benny files are read directly from `.pi/automations/benny/`. Do not add that directory to a package's `pi.skills` or expect its `SKILL.md` files to appear in the slash-skill list.

Tell the user that `.pi/settings.json`, `.pi/automations/benny/`, and any referenced secret-free configuration must be committed before either automation is enabled. Do not commit them unless the user asks.

Once this check passes, live automation prompts may read the committed operational files by their stable repository-relative paths. They must not embed an installed package path or copy the file contents.

## 2. Adapt the configuration

Open these copied examples:

- `../../templates/configuration.example.yaml`
- `../reproduce-and-fix-issues/references/feature-map.example.md`

Create user-owned copies outside `.pi/automations/benny/`. These are configuration files, not pack files. Example locations:

- Project config, such as `.pi/benny/configuration.yaml`
- Project feature map, such as `.pi/benny/feature-map.md`
- Project routing map, such as `.pi/benny/routing.md`
- User config, such as `~/.config/benny/configuration.yaml`
- User feature map, such as `~/.config/benny/feature-map.md`

Fill one feature-map section for every user-facing feature the automation may reproduce. Keep it at the user point of view. Do not freeze implementation details or current code paths in the map.

Do not edit the copied examples. Pack refreshes may update source-managed files after conflict review, but they must never touch the user-owned copies.

Prefer committed, secret-free files in the target repository when a fresh automation checkout must read them. Otherwise paraphrase the required values into the live prompt. Reference a repository file only after `check-benny.mjs <job file>` confirms that the file is committed in the repository where the automation runs.

Use stable repository-relative paths for committed pack and configuration files. Never reference the pstack package's source or installed path from a live automation.

## 3. Fill the required choices

Ask for or confirm:

- Source Slack channel ID
- Optional operations or status channel ID
- Repository URL and default branch
- Triage identity or Slack user ID
- Issue tracker type, team, project, labels, and intake status
- Tracker adapter skill or MCP actions
- Optional routing map path
- Required control skill name
- Required user-facing feature-map path
- Status emoji strings
- Pull request URL format
- Polling and effort budgets
- Model ID for triage, repro, code work, and media review

Use only model IDs that `pi --list-models` shows as available. Do not guess an ID and do not carry over a private default.

The source channel, triage identity, repository, tracker adapter, control skill, and feature map must be explicit. Fail setup if any required value stays ambiguous.

Use pstack's `unslop` skill on the final automation names, descriptions, and prompt shims before saving them.

## 4. Check integration capabilities

The triage automation needs:

- Read access to the configured source Slack channel and its threads
- Thread-reply access in that channel
- Attachment metadata and file download access when reports include media
- Search, read, create, and update access through the configured issue-tracker adapter

The repro automation needs:

- Read access to the source thread
- Thread-reply access in the source channel
- Optional post and edit access in the configured operations channel
- Repository read and history access
- A pull request action that can open a draft pull request
- The configured control-adapter skill

Prefer configured Slack MCP tools, listed by `pi mcp list`, for reads and posts. The optional `BENNY_SLACK_BOT_TOKEN` may fill a narrow gap such as editing one operations status message or downloading an attachment. Store the value in a secret manager or environment, not in YAML.

Do not use undocumented integration endpoints.

The Slack watcher that starts both automations reads the source channel's history with a token in `PSTACK_SLACK_TRIGGER_TOKEN` and signs each trigger with a shared `PSTACK_EVENT_SECRET`. Store both in a secret manager or environment. The job runner removes both from each automation's environment.

## 5. Prepare the routing map

If the user wants reroutes or owner pings:

1. Copy `../triage-issue-reports/references/routing.example.md` outside `.pi/automations/benny/`.
2. Replace every placeholder with public or organization-local values.
3. Keep owner pings off by default.
4. Allow a ping only for a configured feature owner or a confirmed likely regression author.

If no routing map is configured, triage may classify a report but must not guess a destination or owner.

## 6. Verify the control adapter

Read `../reproduce-and-fix-issues/references/control-adapter.md` and the user's completed feature map.

Confirm that the named skill can:

- Bring up the target app
- Navigate every mapped feature through the real UI
- Exercise mapped states through declared adapter actions
- Inspect state without forcing the result
- Capture screenshots
- Start and stop a recording
- Clean up its processes and temporary data

If any capability is missing, leave the repro automation disabled. It must fail closed rather than claim a reproduction it did not perform.

## 7. Prepare the live automations

Ask whether this is first-time creation or configuration of existing automations.

Read `../../FOR_AGENTS.md` from the copied pack as the primary user-intent source for either path. Use it to understand the two triggers, tools, instructions, outcomes, and shared rules.

### First-time creation

Create one automation at a time.

For each automation:

1. Read the matching copied prompt template as secondary internal source material.
2. Turn `FOR_AGENTS.md`, the finished Benny configuration, and the template intent into a complete natural-language request.
3. Tell the live prompt to read and follow its exact committed operational file under `.pi/automations/benny/`.
4. Use the stable repository-relative path, not the pstack package's source or installed path. Do not copy the operational file contents into the live prompt.
5. Run `/pstack-automation benny-triage` or `/pstack-automation benny-repro` in the target repository. It writes a disabled draft job file, with the matching template as its `instructions`, and prints the path.
6. Discover the Slack channels, the repository, and the connected integrations (`pi mcp list`). Fill the draft's `name`, `instructions`, `model`, `config.sourceChannel`, and `config.defaultBranch`, and add the Slack and tracker MCP tools to `tools` by their `mcp__<server>__<tool>` names.
7. Run `node <pstack>/src/jobs/check-benny.mjs <job file>`. It confirms that the copied pack, `.pi/settings.json`, and every `.pi/` file the instructions name are committed on the default branch of the same repository where the automation will run, and that a fresh checkout of that branch gets the shared skills from project scope.
8. Show the user the draft as a table, obtain approval, ask whether they are ready, and hand over the job file. The user enables it by setting `"enabled": true`.
9. Finish the job-file handoff for this automation before starting the next one.

Fill the triage draft with this complete triage intent, filled from configuration:

- Name `benny-triage`.
- Read and follow `.pi/automations/benny/skills/triage-issue-reports/SKILL.md` for every run.
- Trigger on each new top-level report in the configured source Slack channel.
- Read the triggering thread and reply only inside it.
- Use the configured issue-tracker integration.
- Classify, inspect evidence, trace cause, dedupe, and create only clear new bugs.
- End one thread-only verdict with the configured `[benny:bug]`, `[benny:performance]`, or `[benny:other]` marker and optional tracker URL.
- Never post a source-channel root message.

After the triage job-file handoff is complete, fill the repro draft with this complete repro and fix intent:

- Name `benny-reproduce`.
- Read and follow `.pi/automations/benny/skills/reproduce-and-fix-issues/SKILL.md` for every run.
- Trigger on the same new top-level reports in the configured source Slack channel.
- Use the configured repository and default branch.
- Read the source thread and reply only inside it.
- Include pull request creation and the configured tracker, control-adapter, and feature-map requirements. Paraphrase mapped user paths and states unless `check-benny.mjs` confirms an eligible committed file in the same repository.
- Wait for a trusted triage marker before acting.
- Reproduce the exact symptom twice through the mapped real UI and capture evidence.
- Verify an existing fix without authoring over it.
- Attempt an optional bounded fix only after confirmed repro, then open a draft pull request when proof and checks pass.
- Never post a source-channel root message.

`/pstack-automation` only writes the draft. The steps above do the Slack, repository, integration, completeness, authentication, draft-review, approval, readiness, and job-file handoff work; do each once.

### Existing automations

`/pstack-automation` is creation-only: it writes a new draft and never overwrites a job file. Do not use it to search for, inspect, or update existing automations.

Finish configuration, routing, control-adapter, and feature-map validation. Then give the user this concise job-file checklist.

For the existing triage automation, update:

- Name and description
- Direct instruction to read `.pi/automations/benny/skills/triage-issue-reports/SKILL.md`
- New top-level Slack report trigger and source channel
- Slack thread read and reply capabilities
- Issue-tracker integration
- Paraphrased triage instructions, thread-only rule, and Benny verdict markers

For the existing repro automation, update:

- Name and description
- Direct instruction to read `.pi/automations/benny/skills/reproduce-and-fix-issues/SKILL.md`
- Matching Slack trigger and source channel
- Repository and default branch
- Slack thread read and reply capabilities
- Pull request action
- Tracker, control-adapter, and feature-map requirements
- Paraphrased marker wait, evidence, verification, and bounded-fix instructions

Ask the user to update each existing automation directly in its job file. Do not create replacements or duplicates.

### Creation boundary

Never set `"enabled": true` in a job file, run `run-job.mjs`, or start `watch-slack.mjs` yourself. For new automations, the only finish path is the reviewed job-file handoff, where the user enables the job.

Do not enable either automation for normal traffic until the thread-safety test passes after the job file is saved.

## 8. Test thread safety

Use a test channel or a harmless test report.

Before testing, confirm that the target repository's `.pi/settings.json`, `.pi/automations/benny/`, and every referenced secret-free configuration file are committed on the branch used by the automation checkout. Confirm that both live prompts point at their exact committed operational files. `check-benny.mjs` on each job file checks both. If any check fails, stop. Tell the user that the automation cannot be enabled yet.

Ask the user to enable both job files with the test channel as `config.sourceChannel`, then start `node <pstack>/src/jobs/watch-slack.mjs <triage job file> <repro job file>`. Each run keeps its Pi session, output, and fresh checkout under `runs/` beside its job file.

Verify:

1. Triage stores the root `thread_ts` and posts exactly one verdict as a reply.
2. The verdict contains one configured marker.
3. Repro accepts the marker only from the configured triage identity.
4. Repro keeps the same immutable source coordinates.
5. No source-channel root message appears.
6. A delegated worker cannot use any Slack write action.
7. Missing coordinates, a deleted parent, or a failed preflight produces no post and no tracker issue.

Enable normal traffic only after all seven checks pass.
