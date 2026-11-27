# Pi pstack workflow kit

## What is this?

[Pi](https://pi.dev/) is a coding helper. You type what you want, and it reads and writes code for you.

This package teaches Pi a careful way to work. It is called **pstack**.

With pstack, Pi does these things:

- It makes a plan before it starts.
- It does one small step at a time.
- It checks that each step really works.
- It can ask other helpers to work at the same time.

pstack was first made by Lauren Tan for a different coding tool, called Cursor. This package brings the same instructions to Pi, so you do not need Cursor.

## What you need

- **Pi** 1.6.0 or 1.6.1
- **Node.js** 22.23.5 or later in the 22.x line, 24.22.3 or later in the 24.x line, or 26.13.1 or later in the 26.x line. We support Linux and macOS. CI also runs Windows checks, but Windows is not supported.
- **Git**, if you want helpers to work on their own copy of your code
- **The GitHub tool `gh`**, if you want Pi to work with pull requests

## Install it

1. Install Pi, if you do not have it yet:

   ```sh
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   ```

2. Add pstack to Pi:

   ```sh
   pi install npm:pi-pstack-workflow-kit
   ```

3. Check that it is there:

   ```sh
   pi list
   ```

**Just want to try it once?** Run `pi -e npm:pi-pstack-workflow-kit`. Nothing is installed.

**Only want it in one project?** Add `--local` to the install line.

## Your first steps

Start Pi, then type these:

1. `/setup-pstack` to pick which AI models do which jobs. You can skip this. pstack picks good ones for you.
2. `/poteto-mode on` to turn on the careful way of working.
3. Ask for something, like: _"Fix the login bug and show me it works."_

When you want to stop, type `/poteto-mode off`.

## Commands you can type

| Type this                                 | What it does                                                     |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `/poteto-mode on`                         | Turn the careful way of working on.                              |
| `/poteto-mode off`                        | Turn it off.                                                     |
| `/poteto-mode fix the parser`             | Use it for one job only.                                         |
| `/pstack-run bug-fix fix the login`       | Pick the plan yourself. Here the plan is `bug-fix`.              |
| `/pstack-status`                          | See the goal and the to-do list.                                 |
| `/pstack-goal all tests pass`             | Set a goal that Pi keeps in mind.                                |
| `/pstack-loop 60 10 check if CI is green` | Wake Pi every 60 seconds, up to 10 times, to check on something. |
| `/pstack-loop stop`                       | Stop waking Pi.                                                  |
| `/pstack-pause`                           | Stop for now, and save a note on where you were.                 |
| `/pstack-clear`                           | Throw away the plan and goal. Saved files stay.                  |
| `/pstack-map`                             | Look around everything pstack knows.                             |
| `/setup-pstack`                           | Pick models. `/setup-pstack show` shows what you picked.         |

There are also 53 named skills, like `/deslop`, `/tdd` and `/why`. Each one is a set of instructions for one kind of job. Every skill also works as `/skill:<name>`. The guide in [`src/docs/guide/`](src/docs/guide/README.md) explains them.

## The to-do list

When Pi works on something, it keeps a to-do list. Each time the list changes, Pi shows it in the chat:

```
figure-it-out 1/3
[x] 1. Reproduce the bug
[ ] 2. Write a failing test
[ ] 3. Fix the root cause
```

The bar at the bottom of the screen shows how far along it is. Pi can only call the job finished when every item is done, or skipped for a reason.

## Helpers

Pi can start other copies of itself to help. We call them **workers**.

- **One worker** does one job.
- **A swarm** is many workers, each doing its own job.
- **An arena** is many workers doing the same job. A judge picks the best answer.
- **Interrogate** sends workers to try to break your idea, so you find the weak spots early.

Workers that only read never change your files. Workers that write each get their own copy of your code, called a **worktree**, so they cannot mess up yours. Pi looks at their work before it uses any of it.

A worker can also keep running in the background while you do other things. Pi can list, check on and stop its workers.

## Picking models

Different jobs can use different AI models. For example, a big model for hard bugs and a quick one for small edits.

Type `/setup-pstack` to choose. Your choices are saved in `~/.pi/agent/pstack-models.json`.

If you never choose, pstack uses the models its original author picked. If you do not have one of them, it uses the closest one you do have.

## Please be careful

- Workers run on your computer, with your computer's permissions. A worktree keeps their changes apart, but it is not a locked box. Do not give pstack secrets or code you do not trust.
- pstack only merges pull requests after you say yes. It shows you exactly what it will merge first.
- The `ci-watcher` worker can run commands in your own folder, so it can check your pull requests.

## Benny: help with bug reports (optional)

Benny is an extra you can set up. It watches a Slack channel for bug reports.

1. When someone posts a report, Benny sorts it: is it a bug, a slow spot, or something else?
2. If it is a real bug, a second job tries to make the bug happen again and records proof.
3. If it can, it suggests a small fix as a draft pull request. It never merges anything.

To set it up, point Pi at [`src/automations/benny/FOR_AGENTS.md`](src/automations/benny/FOR_AGENTS.md) and say which project to use. Pi walks you through the rest.

Benny runs on your own computer. Use a computer or account just for Benny if you leave it running alone. If the watcher reports an unconfirmed run, inspect its `runs/` directory before retrying. Benny does not replay a claim that may already have changed Slack or the tracker.

Set `PSTACK_PI_BIN` to override the Pi executable. An absolute `.js`, `.mjs`, or `.cjs` entry runs with Node.js. A supervisor that starts `run-job.mjs` with Node IPC can send `{ "type": "stop" }` to request shutdown and let the runner record its result.

## Working on this package

These steps are for people who change the package itself.

**Check everything still works:**

```sh
npm ci --ignore-scripts
npm run verify
```

- `npm run check` checks formatting, lint, and TypeScript. `npm test` runs the complete Vitest suite. Use `npm run test:unit` or `npm run test:integration` to run one group.
- The catalog consistency test uses Python 3. Run `python3 scripts/generate.py --check` to check the generated catalog. Run it without `--check` to regenerate the files.
- `npm run bench` measures catalog search and dependency-view construction.
- `npm run verify` also runs coverage, audits dependencies, inspects the package, and runs the package smoke test. It stops at the first failed check.
- `npm run test:package` checks the tarball for nested installs and local credential or Pi state files. It then installs the tarball in a temporary directory and loads the extension without making model calls. The default host is the pinned Pi version. Use `npm run test:package -- 1.6.0` to check Pi 1.6.0.
- The bundled Statechart CLI tests run offline. Run `npm --prefix src/skills/statechart/scripts test`. Use `test:coverage` in place of `test` for the Node report that includes the CLI subprocesses.
- The root Vitest suite includes the bundled `watch-pr` tests. To check that the same tests also pass under the standalone runtime, use Bun 1.4.5. In `src/skills/poteto-mode/scripts`, run `bun install --frozen-lockfile --ignore-scripts`, `bun run typecheck`, and `bun run test`.

### Release on npm

Before 1.0, use a minor release for breaking changes and a patch release for compatible fixes. Update `CHANGELOG.md`, `package.json`, and `package-lock.json` in the release pull request.

Set up trusted publishing once after `stage-npm.yml` is on `main`:

1. In GitHub, restrict the `npm` Actions environment to deployments from the `main` branch.
2. In the [npm package settings](https://www.npmjs.com/package/pi-pstack-workflow-kit), add a GitHub Actions trusted publisher. Enter owner `just-joshn`, repository `pi-pstack`, workflow `stage-npm.yml`, and environment `npm`.
3. Allow only `npm stage publish`. Disable direct publishing and dist-tag management for this publisher. Remove any legacy publisher for `release.yml`. Require 2FA and disallow package publishing tokens. Remove the old GitHub `NPM_TOKEN` secret if it is no longer used.

Stage and approve the first version within two days of adding the trusted publisher. If the version on `main` is unpublished, use **Run workflow** to stage it without another version bump.

Merge the release pull request. A stable version increase on `main` runs the release checks, verifies one tarball on both supported Pi versions, and stages it on npm. Other pushes skip staging. Once CI passes, open **Staged Packages** on npmjs.com. Review the version and tag, click **Approve**, and complete 2FA. You do not need to run a local release command or create a tag.

If a run fails before staging, use **Re-run jobs** on its GitHub Actions run. If the artifact expired, rerun all jobs to rebuild it. If the version is still on `main`, you can also open **Stage npm package** in **Actions** and click **Run workflow**. Select `main` and enter the exact version in its `package.json`. For an older release, select **backfill** to leave the `latest` tag unchanged. The workflow cannot recover missing source or assign a new version to existing source. If npm already has a staged entry for the version, review that entry instead of staging it again. If the entry has the wrong tag, reject it on npmjs.com before you rerun the workflow.

### Sync GitHub releases

After npm publishes an approved version, the [Sync GitHub releases workflow](.github/workflows/sync-github-releases.yml) checks for missing GitHub releases once an hour. It starts at `0.5.0`. It verifies npm signatures and provenance from `stage-npm.yml` on `main`, then uses the verified commit for the tag and changelog. It never writes to npm or moves a Git tag. Keep [immutable GitHub releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) enabled.

To sync without waiting, open **Sync GitHub releases** in **Actions**, click **Run workflow**, and select `main`. Select **Preview** to see which versions would be released without writing any tags or releases.

If any candidate fails provenance or changelog verification, the sync writes nothing for that run. Inspect the run before retrying after a verification failure, conflicting tag, or draft. If GitHub refuses to create a tag with the workflow token, a maintainer can create it at the verified commit shown in the run and rerun the sync. Do not substitute the tip of `main`.

**Find your way around:**

| Folder                   | What is in it                                                 |
| ------------------------ | ------------------------------------------------------------- |
| `src/`                   | Everything the installed package uses.                        |
| `src/skills/`            | The 77 skills and the 22 plans (in `poteto-mode/playbooks/`). |
| `src/agents/`            | Instructions for the different kinds of workers.              |
| `src/docs/guide/`        | The guide.                                                    |
| `src/automations/benny/` | Benny.                                                        |
| `src/jobs/`              | The parts that run Benny without you watching.                |
| `src/reference/`         | Notes on what matches the original and what does not.         |
| `tests/`                 | The tests.                                                    |

The skills, plans, agents, guide and Benny are copied from the original pstack, word for word. Only the sentences that named a Cursor feature were changed, to name the Pi feature that does the same thing. Please keep it that way.

## Where it came from

This package is built from two projects in [cursor/plugins](https://github.com/cursor/plugins):

- **pstack** 0.15.48, by Lauren Tan
- **Cursor Team Kit** 1.2.0, by Cursor

## License

This package's own code uses the MIT License. See [`LICENSE`](LICENSE).

The parts copied from pstack and Cursor Team Kit also use the MIT License. Their license notices are in [`src/licenses/`](src/licenses/README.md), with a list of which files came from where.
