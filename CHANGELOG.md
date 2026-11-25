# Changelog

## 0.2.0 (Unreleased)

BREAKING CHANGES:

- The headless job runner moved from `scripts/run-job.mjs` to `src/jobs/run-job.mjs`. Update any scheduler or script that runs it from an installed package: `node src/jobs/run-job.mjs --run <job.json> [signed-event.json]`.
- The package no longer has top-level `agents/`, `lib/`, `reference/`, `scripts/` or `skills/` directories. They are now under `src/`. For example, the Benny configuration example is now at `src/reference/benny/config.example.json`.

ADDED:

- oxlint enforces the coding-style limits: functions under 50 lines, files under 800 lines, and nesting no deeper than 4 levels. `no-console` is now an error.
- Tests for the input boundaries of JSON parsing and record checks, and of job and signed-event validation.
- Tests that a running write worker's worktree is reported active and cannot be removed, that the job runner passes Pi skill and extension paths that exist, and that the package publishes only `src/`.

CHANGED:

- The package publishes only `src/`, and Pi loads the skills from `src/skills`.
- The coverage gate covers every TypeScript file in `src/`, which now includes `src/lib/` and `src/jobs/job-input.ts`.
- `scripts/generate.py` writes its outputs into `src/` and reports stale files with paths relative to the repository root.
- Tests are organized with one file per feature and no `describe` wrappers.
- Extension functions longer than 50 lines are split into smaller functions.
- The worktrees module owns the record of which worktrees write workers are using. Delegation no longer edits a set shared through `src/index.ts`.

## 0.1.1 (2026-11-25)

NEW FEATURES:

- pstack workers can use models whose provider an extension registers, such as `claude/*` from pi-claude-oauth. `/setup-pstack` lists those models, and delegation loads only the extension that lists the worker's model.

ADDED:

- GitHub Actions checks every pull request: formatting, lint, type checking, generated files, tests with the coverage gate on Node 22.19.0, 24 and 26, and a smoke test on real Pi.
- A push to `main` publishes a new `version` to npm and creates its tag and GitHub release.
- An action lockfile, a lockfile check and a Dependabot configuration for the workflows.
- A coverage gate that requires 80% statement, branch, function and line coverage in each extension file, and 31 tests that meet it.

CHANGED:

- The extension moved from `extensions/` to `src/`, with `src/index.ts` as the entry point.
- The code passes strict TypeScript compiler settings and type-aware oxlint rules.
- The source map and catalog data are validated by type guards when they load.
- The tests are TypeScript on Vitest 5.
- `bun fmt` formats the repository.

REMOVED:

- oxfmt.
- The `smoke`, `generate`, `check:generated` and `check:ci` package scripts. Run `node scripts/smoke.ts` and `python3 scripts/generate.py [--check]` directly.

## 0.1.0 (2026-11-24)

NEW FEATURES:

- A native Pi extension for the pstack and Team Kit workflows.
- 76 native skills, including 52 slash commands, and 22 ordered playbooks, generated from the upstream source map.
- Branch-local plans and goals, `poteto-mode`, and bounded wake loops that only the operator can start.
- Catalog browsing, a decision log and session history.
- Read-only and isolated write delegates in single, swarm, arena and interrogate modes, with configurable role models and a cross-provider arena judge.
- Worktree audit, creation and approved removal.
- PR inspection and a shipping gate that merges a verified prefix of PRs only after operator approval.
- A local headless job runner, with disabled automation drafts and dormant Benny configuration and instructions.
- Public npm distribution as `pi-pstack-workflow-kit`.
