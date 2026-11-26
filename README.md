# Pi pstack workflow kit

An installable Pi package that reimplements the workflows described by the supplied pstack 0.15.48, Team Kit 1.2.0 and Cursor CLI skill map. It uses the current `@earendil-works/pi-coding-agent` extension API, Pi Agent Skills, native Pi child processes, native session entries and native terminal UI. It does not require a Cursor installation, a Cursor account, another coding agent, or an npm runtime dependency beyond the Pi host. It does not ship Cursor's proprietary cloud services.

**Status: a hand port of upstream pstack 0.15.48 and Team Kit 1.2.0, not certified behavioral parity.** Every skill, playbook, principle, agent, reference, guide page and the Benny automation pack is upstream's file ported by hand: text that names nothing Cursor-specific keeps upstream's words, and each sentence that names a Cursor mechanism names the Pi mechanism that does the same job. Upstream's helper scripts (`watch-pr`, `worktree-audit.sh`, `log.sh`, the statechart tools and the PR review canvas) ship with them. All 162 node IDs, 163 dependency edges, and 65 views of the source map are retained and mapped. Model-mediated behavior and the services a project brings are not exercised by the tests; see `src/reference/GAPS.md`.

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

The package registers 53 original slash-skill names (35 ordinary pstack and 18 Team Kit) and ten model-callable tools. All 77 skills, including 24 principle leaves, use the standard `/skill:<name>` interface. Playbooks remain supporting files, not 22 extra ordinary skills. Use Pi's standard `/model`, `/resume`, `/tree`, `/compact`, `/mcp`, `/reload`, `pi install`, and headless JSON/RPC interfaces for host capabilities.

The extension appends the two always-applied Team Kit rules, `no-inline-imports` and `typescript-exhaustive-switch`, to the system prompt while poteto-mode is on (`/poteto-mode on`). Upstream applies them in every Cursor session; here they stay out of sessions that do not use pstack, which may not be TypeScript projects. They are in `src/reference/rules/`.

| Tool              | Behavior                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pstack_catalog`  | Search, inspect nodes, read instructions, list route triggers and browse dependency views.                             |
| `pstack_plan`     | Start, update, inspect or finish a branch-local task list with evidence.                                               |
| `pstack_delegate` | Single, swarm, arena or interrogate workers using independent native Pi CLI processes.                                 |
| `pstack_log`      | Append a timestamped decision record to a TSV.                                                                         |
| `pstack_history`  | Read bounded entries on the active native session branch.                                                              |
| `pstack_wake`     | Start, inspect or stop a bounded wake loop, as upstream's agent arms `/loop`.                                          |
| `pstack_workers`  | List this session's workers with their state and last activity, or stop a background worker.                           |
| `pstack_worktree` | Create isolated Git worktrees, inspect dirty/merged state, approve safe removal.                                       |
| `pstack_pr`       | Read fresh GitHub PR state, head and checks.                                                                           |
| `pstack_ship`     | Require a shipping or autopilot-full plan and operator confirmation; recheck and merge the verified contiguous prefix. |

## Configuration and workers

`/setup-pstack` uses Pi's model registry and native selection dialogs. Nine role selections and the reasoning budget are saved atomically at `$PI_CODING_AGENT_DIR/pstack-models.json`, default `~/.pi/agent/pstack-models.json`. The file uses a `defaults: 3` marker. The parent model remains unchanged. With no saved file, each role takes upstream's default model, matched to the closest model workers can use; a seat with no match runs on the parent model, and the judge pool drops it. The picker lists the models in the current scope that workers can load. It includes a model of a provider registered by an extension when pstack finds that extension: pstack runs `pi --list-models` once per loaded extension that registers a slash command and uses the one that lists the model. Such a model stays excluded when its extension registers no slash command, or when Pi lists the provider without the extension, as it does for one that replaces a built-in provider. Both `auto` and `inherit-parent` resolve to the current parent model; setup warns if workers cannot use it. Delegation checks availability only for the workers and judge selected for that run. For arena and interrogate configure at least two panel seats. Arena uses the first available judge in the configured pool whose vendor differs from the parent and every candidate. Pi itself may clamp reasoning to model support. The `large`, `medium`, `small` budgets lower the role's reasoning target; the Gemini panel seat uses its higher target where selected.

Each delegate starts a fresh Pi CLI process via `pi.exec`. `PSTACK_PI_BIN` can select the Pi binary. Concurrency is bounded to eight workers, with default three concurrent workers. Each job retains its report and native JSONL session. Only bounded output excerpts return to the parent. Read-only reviewers receive only Pi's read/grep/find/ls tools; no shell, write, edit, MCP or discovered extensions. The exception is `ci-watcher`, which, like upstream's, also gets `bash` in the parent's checkout to run `gh` and `git`; nothing stops that shell from writing. Write delegates start without asking, as upstream's reversible work does, and get separate detached Git worktrees at the selected committed ref (default HEAD). Uncommitted parent files are not copied automatically; the parent saves a repository-root-relative patch of up to 2 MiB. If tracked changes alone exceed the limit, no patch is attached. Otherwise, untracked, non-ignored files are added as whole patches while space remains, and workers are told which files were omitted. The parent inspects, reconciles and verifies worker output. Workers never automatically merge, cherry-pick, or delete worktrees. Worktrees are isolation of checkout state, not an OS security sandbox. Child processes inherit the OS environment. A worker whose model comes from a provider registered by an extension also loads that extension. Its code runs in the worker with the trust it has in the parent session; the tool allowlist still limits what the model can call. Delegation refuses a model whose extension it cannot find before starting any worker. Use a real external sandbox for untrusted code or secrets.

Arena stores candidate sessions, removes model metadata and known model names from message projections, asks the independent judge to read the actual projected transcripts, and audits read tool calls. This is partial blinding: transcript text, tool paths or outputs can still identify an author; a read call alone cannot prove the judge read every line. It does not claim a fully controlled evaluation environment. If judging fails, the tool returns an inconclusive judgment alongside the completed candidate reports and their artifact directory.

## Session state and delivery

Task and mode state use Pi's branch-local custom entries. Each `pstack_plan` change draws the plan's checklist in the conversation, and the status bar shows its progress. Timers stop on session shutdown, branch change, abort, completion, or iteration limit. Restored sessions recover state with wake loops paused. If the latest saved pstack state is invalid or unsupported, the extension starts with empty state rather than reviving an older plan. Wakes only run while a terminal Pi session is open. `/pstack-pause` saves a resume note without implicitly committing, deleting or changing a branch. Artifacts live under `$PI_CODING_AGENT_DIR/pstack/sessions/<session-id>/`.

The shipping gate uses GitHub CLI and requires an active shipping or autopilot-full plan. Finishing the plan closes the gate. It requires independent evidence tied to each exact head, shows the exact PR URLs and heads for explicit approval in the terminal UI or via Pi RPC, and checks readiness immediately before each `gh pr merge --match-head-commit`. If an initial PR lookup fails, the gate can still offer the verified prefix before it and reports the failed lookup as `lookupFailure`. A merge counts as confirmed only when GitHub reports `MERGED` at the approved head. If a merge was attempted but its result could not be confirmed, the tool reports its PR number separately as `unconfirmed`, not `unmerged`. Inspect the forge state before retrying. The operator must verify that order and the provenance of the evidence; the extension cannot prove the stack topology or that a model's evidence string is truthful. The gate applies to its own tool, not arbitrary user-installed tools or the parent's general shell. It does not merge in autopilot-stack or in print or JSON mode. The model cannot select the `shipping` or `autopilot-full` route through `pstack_plan` without a confirmation; `/pstack-run` selects it directly. Worktree removal also requires a confirmation-capable UI. Removal deletes ignored files in the worktree. The confirmation counts individual ignored paths, including files inside ignored directories, and shows the first ten. Removal stops if the path list changes after approval. Origin-specific operations are instructions only; no Origin service is bundled.

## Benny and automation

Benny is upstream's automation pack for Slack issue reports, in `src/automations/benny/`. One automation triages each new top-level report in a source channel; the other waits for the triage verdict, reproduces confirmed bugs through a configured app-control skill, and may open a draft PR. To set it up, point Pi at `src/automations/benny/FOR_AGENTS.md` and name the target repository. Setup copies the pack to the target's `.pi/automations/benny/`, adds pstack to its `.pi/settings.json`, and fills a job file for each automation.

Pi has no hosted automation service, so the package supplies one:

- `/pstack-automation benny-triage`, `/pstack-automation benny-repro` or `/pstack-automation custom` writes a disabled draft job file in the session artifact directory, with upstream's prompt template as its instructions. It never overwrites a file. The operator enables a job by setting `"enabled": true`.
- `node src/jobs/check-benny.mjs <target repository>` starts a fresh Pi rooted there and reports any of Benny's shared pstack skills that do not come from project scope. `node src/jobs/check-benny.mjs <job.json>` also checks that the pack, `.pi/settings.json` and every `.pi/` file the instructions name are committed on the default branch, and runs the skill check in a fresh checkout of it.
- `node src/jobs/watch-slack.mjs [--once] [--interval <seconds>] <job.json>...` polls each job's source channel with `conversations.history`, using a Slack token in `PSTACK_SLACK_TRIGGER_TOKEN`. For each new top-level post or file share it starts every job watching that channel, oldest report first. A channel seen for the first time starts from now. The cursor is saved in `watch-state.json` beside the first job file. Run it as a long-lived process, or with `--once` from a scheduler such as launchd or cron.
- `node src/jobs/run-job.mjs --run <job.json> [signed-event.json]` runs one job headless in Pi. The watcher signs upstream's trigger (`source_channel_id`, `message_ts`, `thread_ts`) with HMAC-SHA256 under `PSTACK_EVENT_SECRET`, and the runner rejects any other signature, channel or reply. A Benny run works in a fresh detached checkout of `origin/<defaultBranch>` under `runs/<id>/checkout`, as an automation's agent does, gets the trigger in the template's `{{SLACK_*}}` placeholders, and gets pstack's skills from the checkout's project settings. Pi lists no manual-only skill to the model, so the runner names the file of each shared skill Benny uses in the run's system prompt, and fails closed if any is not in project scope. A report runs once per job: a second dispatch of the same report fails. The runner removes `PSTACK_EVENT_SECRET` and `PSTACK_SLACK_TRIGGER_TOKEN` from the run's environment and sends the prompt on stdin. Each run keeps its Pi session, output, checkout and a `result.json` receipt.

A Benny job runs with the tools in its file, as upstream's automation runs with its configured tools: the pack's drafts give triage read tools, `bash` and `pstack_delegate`, and repro adds `edit` and `write`. Add the Slack and tracker MCP tools by name. Upstream's safety rules (thread-only posts, no Slack writes from workers, draft PRs only, no merge or deploy) live in the operational files, as they do upstream. `pstack_delegate`'s read-only workers have no MCP tools and no shell, so they cannot reach Slack. Runs execute on the local machine with its permissions; use a dedicated machine, account or container for unattended runs.

A custom job runs in its `cwd` with the package's skills and takes an optional signed event as untrusted data, which `/make-bot-ui` uses.

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
- `src/skills/`, `src/agents/`, `src/docs/guide/`: 77 skills with 22 playbooks, four agents and the guide, ported by hand from upstream.
- `src/agents/`: worker and reviewer contracts.
- `src/jobs/`: `run-job.mjs`, the headless job runner; `watch-slack.mjs` and `slack-watch.ts`, the Slack trigger; `check-benny.mjs` and `job-check.ts`, the setup check; and `job-input.ts`, job and event validation.
- `src/reference/source-map.json`: original attachment, unchanged byte-for-byte.
- `src/reference/parity.json` (generated): machine-readable original IDs, edges and views with implementation classifications.
- `src/reference/PARITY.md`, `src/reference/GAPS.md`: audit matrix and residual gaps.
- `src/automations/benny/`: upstream's Benny pack, ported by hand.
- `src/licenses/`: upstream pstack's and Team Kit's MIT notices, and which files came from each.
- `scripts/catalog-source.json`: Pi implementation classifications and paths for the source map's nodes.
- `scripts/generate.py`: `python3 scripts/generate.py` rebuilds `src/lib/catalog-data.json` (with each playbook's numbered steps for `pstack_plan`), `src/reference/parity.json` and `src/reference/PARITY.md`. It never writes the ported files.
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

Every upstream source URL from the map remains in `src/reference/source-map.json` and `src/reference/parity.json`.

## License

This package's own code is under the MIT License in `LICENSE`. The skills, agents, rules, guide and Benny pack ported from upstream pstack (copyright Lauren Tan) and Cursor Team Kit (copyright Cursor) are also MIT-licensed; their notices ship unchanged in `src/licenses/`, which lists the files that came from each.
