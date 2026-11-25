# Pi pstack workflow kit

An installable Pi package that reimplements the workflows described by the supplied pstack 0.15.48, Team Kit 1.2.0 and Cursor CLI skill map. It uses the current `@earendil-works/pi-coding-agent` extension API, Pi Agent Skills, native Pi child processes, native session entries and native terminal UI. It does not require a Cursor installation, a Cursor account, another coding agent, or an npm runtime dependency beyond the Pi host. It does not ship Cursor's proprietary cloud services.

**Status: source-map-complete implementation candidate, not certified behavioral parity.** All 162 node IDs, 163 dependency edges, and 65 views are retained and mapped. The skills and playbooks are independently written from the JSON descriptions, with selected official upstream source cross-checks. They are not a complete copy of the upstream pinned repository's leaf files, scripts, templates, or full playbook contracts. Some nodes are model-mediated skills or require a project's own tools. The managed service gaps and test limits are explicit in `src/reference/PARITY.md` and `src/reference/GAPS.md`.

## Install

Requires Pi and Node.js 22.19 or newer. Verification below uses Pi 1.6.0, Bun, and Python 3.9 or newer for the generator checks. Pi's own minimum runtime version takes precedence. Git is required for worktree features and the integration tests. GitHub CLI (`gh`) and authentication are required for GitHub operations. Browser, terminal, formal proof, video, Slack and tracker workflows depend on the relevant configured project tools.

Install current Pi if needed, following the official [Quickstart](https://docs.pi.dev/latest/quickstart) or [pi.dev](https://pi.dev/):

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Install the npm package in Pi:

```sh
pi install npm:pi-pstack-workflow-kit
pi list
```

Use `pi -e npm:pi-pstack-workflow-kit` to try it for one session. Add `--local` to `pi install` to register it in the current project instead. For a source checkout, run `pi install "$PWD"` from the package directory. Project resources require Pi project trust. Review the extension before granting trust, then use `/reload` or restart Pi.

## Use

```text
/setup-pstack
/setup-pstack show
/poteto-mode on
/pstack-run bug-fix Reproduce the failing login, fix it, and prove the original flow passes
/pstack-status
/pstack-map
/pstack-map all-dependencies
/pstack-map cli-cloud
/pstack-goal All required checks pass on the verified patch
/pstack-loop 60 10 Check current-head CI and stop when green or blocked
/pstack-loop stop
/pstack-pause
/pstack-clear
/poteto-mode off
```

`/poteto-mode <goal>` attaches the workflow to one request. `/poteto-mode on` persists the router for the selected session branch. The receiving session selects and owns the playbook. `/pstack-run <route> <goal>` selects an explicit playbook. The native task tool initializes ordered steps, records evidence and requires each step to be completed or explicitly skipped before finishing. The router chooses `figure-it-out` for broad/unmatched work. Use `/skill:principle-...` to read a specific principle; the principles are conditional rather than a fixed sequence.

The package registers 53 original slash-skill names (35 ordinary pstack and 18 Team Kit) and nine model-callable tools. All 77 skills, including 24 principle leaves, use the standard `/skill:<name>` interface. Playbooks remain supporting files, not 22 extra ordinary skills. Use Pi's standard `/model`, `/resume`, `/tree`, `/compact`, `/mcp`, `/reload`, `pi install`, and headless JSON/RPC interfaces for host capabilities.

The extension appends the two always-applied Team Kit rules, `no-inline-imports` and `typescript-exhaustive-switch`, to the system prompt of every session, as upstream applies them in every Cursor session. They are in `src/reference/rules/`.

| Tool              | Behavior                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pstack_catalog`  | Search, inspect nodes, read instructions, list route triggers and browse dependency views.                             |
| `pstack_plan`     | Start, update, inspect or finish a branch-local task list with evidence.                                               |
| `pstack_delegate` | Single, swarm, arena or interrogate workers using independent native Pi CLI processes.                                 |
| `pstack_log`      | Append a timestamped decision record to a TSV.                                                                         |
| `pstack_history`  | Read bounded entries on the active native session branch.                                                              |
| `pstack_wake`     | Inspect or stop a bounded operator-started loop.                                                                       |
| `pstack_worktree` | Create isolated Git worktrees, inspect dirty/merged state, approve safe removal.                                       |
| `pstack_pr`       | Read fresh GitHub PR state, head and checks.                                                                           |
| `pstack_ship`     | Require a shipping or autopilot-full plan and operator confirmation; recheck and merge the verified contiguous prefix. |

## Configuration and workers

`/setup-pstack` uses Pi's model registry and native selection dialogs. Nine role selections and the reasoning budget are saved atomically at `$PI_CODING_AGENT_DIR/pstack-models.json`, default `~/.pi/agent/pstack-models.json`. The file uses a `defaults: 3` marker. The parent model remains unchanged. Cursor-specific model slugs do not map reliably to Pi provider IDs, so unconfigured roles inherit the parent; explicitly choose available `provider/id` models. The picker lists the models in the current scope that workers can load. It includes a model of a provider registered by an extension when pstack finds that extension: pstack runs `pi --list-models` once per loaded extension that registers a slash command and uses the one that lists the model. Such a model stays excluded when its extension registers no slash command, or when Pi lists the provider without the extension, as it does for one that replaces a built-in provider. Both `auto` and `inherit-parent` resolve to the current parent model; setup warns if workers cannot use it. Delegation checks availability only for the workers and judge selected for that run. For arena and interrogate configure at least two panel seats. Arena uses the first available judge in the configured pool whose vendor differs from the parent and every candidate. Pi itself may clamp reasoning to model support. The `large`, `medium`, `small` budgets lower the role's reasoning target; the Gemini panel seat uses its higher target where selected.

Each delegate starts a fresh Pi CLI process via `pi.exec`. `PSTACK_PI_BIN` can select the Pi binary. Concurrency is bounded to eight workers, with default three concurrent workers. Each job retains its report and native JSONL session. Only bounded output excerpts return to the parent. Read-only reviewers receive only Pi's read/grep/find/ls tools; no shell, write, edit, MCP or discovered extensions. Write delegates require explicit confirmation in the terminal UI or via Pi RPC and get separate detached Git worktrees at the selected committed ref (default HEAD). Uncommitted parent files are not copied automatically; the parent saves a repository-root-relative patch of up to 2 MiB. If tracked changes alone exceed the limit, no patch is attached. Otherwise, untracked, non-ignored files are added as whole patches while space remains, and workers are told which files were omitted. The parent inspects, reconciles and verifies worker output. Workers never automatically merge, cherry-pick, or delete worktrees. Worktrees are isolation of checkout state, not an OS security sandbox. Child processes inherit the OS environment. A worker whose model comes from a provider registered by an extension also loads that extension. Its code runs in the worker with the trust it has in the parent session; the tool allowlist still limits what the model can call. Delegation refuses a model whose extension it cannot find before starting any worker. Use a real external sandbox for untrusted code or secrets.

Arena stores candidate sessions, removes model metadata and known model names from message projections, asks the independent judge to read the actual projected transcripts, and audits read tool calls. This is partial blinding: transcript text, tool paths or outputs can still identify an author; a read call alone cannot prove the judge read every line. It does not claim a fully controlled evaluation environment. If judging fails, the tool returns an inconclusive judgment alongside the completed candidate reports and their artifact directory.

## Session state and delivery

Task and mode state use Pi's branch-local custom entries. Timers stop on session shutdown, branch change, abort, completion, or iteration limit. Restored sessions recover state with wake loops paused. If the latest saved pstack state is invalid or unsupported, the extension starts with empty state rather than reviving an older plan. Wakes only run while a terminal Pi session is open. `/pstack-pause` saves a resume note without implicitly committing, deleting or changing a branch. Artifacts live under `$PI_CODING_AGENT_DIR/pstack/sessions/<session-id>/`.

The shipping gate uses GitHub CLI and requires an active shipping or autopilot-full plan. Finishing the plan closes the gate. It requires independent evidence tied to each exact head, shows the exact PR URLs and heads for explicit approval in the terminal UI or via Pi RPC, and checks readiness immediately before each `gh pr merge --match-head-commit`. If an initial PR lookup fails, the gate can still offer the verified prefix before it and reports the failed lookup as `lookupFailure`. A merge counts as confirmed only when GitHub reports `MERGED` at the approved head. If a merge was attempted but its result could not be confirmed, the tool reports its PR number separately as `unconfirmed`, not `unmerged`. Inspect the forge state before retrying. The operator must verify that order and the provenance of the evidence; the extension cannot prove the stack topology or that a model's evidence string is truthful. The gate applies to its own tool, not arbitrary user-installed tools or the parent's general shell. It does not merge in autopilot-stack or in print or JSON mode. The model cannot select the `shipping` or `autopilot-full` route through `pstack_plan` without a confirmation; `/pstack-run` selects it directly. Worktree removal and write delegation also require a confirmation-capable UI. Removal deletes ignored files in the worktree. The confirmation counts individual ignored paths, including files inside ignored directories, and shows the first ten. Removal stops if the path list changes after approval. Origin-specific operations are instructions only; no Origin service is bundled.

## Benny and automation

`/pstack-automation benny-triage`, `/pstack-automation benny-repro`, or `/pstack-automation custom` creates an initially disabled draft in the session artifact directory. It refuses to overwrite a previous draft. Copy the Benny configuration template to a trusted target project outside the package. Configure project-specific Slack/tracker/control MCP tools, and use an explicit allowlist in the draft. Review the tool semantics. Benny requires narrowly scoped tools and prohibits the generic shell, codemode, dynamic tool search and MCP tool names whose words (snake_case, kebab-case or camelCase) indicate merge, squash, rebase, push, commit, deploy, publish, delete, exec, shell, script or command operations, or create/update/write of files, branches or refs. Native `edit` and `write` are accepted only for `benny-repro`; `benny-triage` is read-only. Pull request creation tools are accepted only for `benny-repro` with `allowDraftPr: true`. This is not a security sandbox; configured MCP permissions must enforce those restrictions too.

`node src/jobs/run-job.mjs --run /absolute/path/job.json [signed-event.json]` is a local headless Pi entrypoint. It is not a daemon, managed cloud worker, Slack subscription, or scheduler. The job and Benny config must be separately enabled by the operator. The external trusted event adapter must provide an envelope `{ "payload": "<JSON string>", "signature": "<HMAC-SHA256 hex>" }`, signed with `PSTACK_EVENT_SECRET`. A report payload includes `type: "report"`, `topLevel: true`, `channel`, `thread`, and `eventId`. A reproduction payload includes `type: "triage-marker"`, `trusted: true`, `classification: "bug"` or `"performance"`, `ticket`, and the same immutable thread identity fields. The adapter, not arbitrary Slack text, establishes trust. A claimed run directory is unique per workflow/thread; repeated dispatches fail closed. If Pi cannot start, the runner prints the claim location and writes a sanitized `not-started` receipt to `result.json`. An absent receipt is not proof that Pi never started. Investigate ambiguous failures before rearming any event. The runner removes the event signing secret from the child environment and sends the prompt through stdin rather than as process arguments. Pi can load skills and prompt templates from the trusted project; the job's explicit tool allowlist still applies. It preserves private run logs and uses Pi's native MCP integration for explicitly named external tools. Benny's application-specific adapter, event receiver, tracker actions and real end-to-end proof are not implemented by this generic package. See `src/reference/benny/`.

## Verify

Run the development checks from a source checkout:

```sh
bun install --frozen-lockfile
bun run check
python3 scripts/generate.py --check
node scripts/smoke.ts
```

`bun run check` runs the `bun fmt` format check, type-aware oxlint, the TypeScript compiler against the installed Pi SDK, and the tests with the coverage gate. `bun run format` and `bun run lint:fix` apply the fixes. The formatter skips the three configuration files listed in `.prettierignore`, which are kept exactly as written. `python3 scripts/generate.py --check` reports generated files that no longer match their sources.

The tests are TypeScript on Vitest and run without a build step. `bun run test` runs them once and `bun run test:watch` reruns them as files change. They use a mock Pi host and forge, a fake child CLI for job dispatch, and temporary real Git repositories. `bun run test:coverage` also applies the gate in `vitest.config.ts`: each TypeScript file in `src/`, which holds everything the installed extension loads, needs 80% statement, branch, function and line coverage.

`node scripts/smoke.ts` launches real Pi in an isolated RPC session without model requests. It checks discovery of all 77 native skills and 53 original slash names, writes and reads mode state, and checks that `/setup-pstack` lists the model of a provider registered by a fixture extension. Set `PSTACK_PI_BIN` to point to a different Pi executable. This smoke does not exercise live models, GitHub, Slack, or MCP services. Test those integrations with disposable resources before relying on them.

## Continuous integration and releases

Three workflows in `.github/workflows` run on GitHub-hosted runners:

- `ci.yml` runs on every pull request. The `Lint` job runs the format check, oxlint, the TypeScript compiler and the generator check. The `Test` jobs run the tests with the coverage gate and the smoke test on Node 22.19.0, 24 and 26. The smoke test uses the Pi that `bun install` puts in `node_modules`.
- `release.yml` runs on every push to `main`. It runs the same checks, then compares `version` in `package.json` with npm. If npm does not have that version, the workflow publishes the package with provenance, then creates the tag `v<version>` and its GitHub release, with generated notes, at the published commit. Runs of this workflow do not overlap: up to 100 wait in a queue.
- `verify-lockfile.yml` runs on pull requests and on pushes to `main`. It fails when `.github/workflows/actions.lock` no longer matches the workflows or the commits it pins.

To release, change `version` in `package.json` in a pull request and merge it. Do not create the tag or the release by hand. The workflow never touches an existing tag, and it stops before publishing when the tag exists and npm does not have the version. npm refuses a prerelease version such as `1.0.0-beta.1` without a dist-tag, so the workflow cannot publish one.

If a run fails after npm accepted the version, use **Re-run all jobs**. While `package.json` still names that version, a run finds it on npm, skips publishing and creates the missing tag and release at the commit npm recorded for it. It creates neither when the tag already exists, or when npm recorded no commit, which is the case for a version published outside a Git checkout.

Publishing needs an npm [trusted publisher](https://docs.npmjs.com/trusted-publishers) for this repository, with the workflow `release.yml`, the environment `npm`, and `npm publish` allowed. No secret is involved. The workflow also accepts an npm access token in a [secret](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) named `NPM_TOKEN`, which is the method in GitHub's documentation, but npm removes direct publishing with a token in January 2027.

The first release run creates the `npm` [environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) without rules. Add a deployment branch rule for `main` so that no other branch can publish.

`actions.lock` pins every action the workflows use to a commit. After you add or change a `uses:` line, run `gh actions-lock` and commit the result. The command comes from the [`gh-actions-lock`](https://github.com/github/gh-actions-lock) extension of the GitHub CLI. Dependabot proposes new releases of the actions each week and updates the lockfile in the same pull request.

CI installs Bun 1.4.5, the release the files were formatted with. Change `BUN_VERSION` in `ci.yml` when you format with a newer Bun.

## Files

Everything the installed package needs lives in `src/`, and the package publishes only that directory. Paths in the catalog are relative to `src/`.

- `src/`: the extension, one file per feature: `session.ts` (branch state and wake timer), `plan.ts`, `catalog-ui.ts`, `records.ts`, `models.ts`, `delegate.ts`, `parent-diff.ts`, `worktrees.ts`, `forge.ts`, with `git.ts` and `support.ts` shared.
- `src/lib/`: type-checked TypeScript with no Pi dependency: `catalog.ts`, `models.ts`, `state.ts`, `pool.ts`, `transcript.ts`, `jobs.ts`, `validation.ts`, and the generated `catalog-data.json`.
- `src/skills/`: 77 native skill directories and 22 nested ordered playbooks (generated).
- `src/agents/`: worker and reviewer contracts.
- `src/jobs/`: `run-job.mjs`, the headless job runner, and `job-input.ts`, its job and event validation.
- `src/reference/source-map.json`: original attachment, unchanged byte-for-byte.
- `src/reference/parity.json` (generated): machine-readable original IDs, edges and views with implementation classifications.
- `src/reference/PARITY.md`, `src/reference/GAPS.md`: audit matrix and residual gaps.
- `src/reference/benny/`: dormant configuration and workflow instructions.
- `scripts/catalog-source.json`: the instructions written for Pi: playbook steps, principle rules, skill bodies and implementation classifications. Edit this, not the generated files.
- `scripts/generate.py`: `python3 scripts/generate.py` rebuilds `src/skills/`, `src/lib/catalog-data.json`, `src/reference/parity.json` and `src/reference/PARITY.md` from the source map and `catalog-source.json`, and formats them with `bun fmt`. Regeneration removes obsolete generator-marked skill and playbook files, not hand-authored files. With `--check` it reports drift without writing.
- `scripts/smoke.ts`, `scripts/smoke-provider.ts`, `tests/`: verification.
- `.github/`: the CI, release and lockfile workflows, the action lockfile and the Dependabot configuration.

## Official references

The extension targets the `@earendil-works` Pi SDK, not the older `@mariozechner` namespace.

- [Extensions](https://docs.pi.dev/latest/extensions)
- [Packages](https://docs.pi.dev/latest/packages)
- [Skills](https://docs.pi.dev/latest/skills)
- [Command line](https://docs.pi.dev/latest/cli)
- [RPC commands](https://docs.pi.dev/latest/rpc-commands)
- [Configuration](https://docs.pi.dev/latest/configuration)
- [Environment variables](https://docs.pi.dev/latest/environment-variables)
- [Pinned original router](https://github.com/cursor/plugins/blob/41e400932eca14f289e7db717a70455256b6d388/pstack/skills/poteto-mode/SKILL.md)
- [Pinned original setup](https://github.com/cursor/plugins/blob/41e400932eca14f289e7db717a70455256b6d388/pstack/skills/setup-pstack/SKILL.md)

Every upstream source URL from the map remains in `src/reference/source-map.json` and `src/reference/parity.json`. No claim is made that the independently authored instructions reproduce every detail in those upstream files.
