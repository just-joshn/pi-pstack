# Git workflow and multi-agent safety

Scope: All repository operations. Assume other agents or the user can modify the same working tree at any time.

## Inspect and preserve

- GIT-01 MUST run `git status --short` before editing. Inspect existing staged and unstaged changes with `git diff --cached` and `git diff`. Identify task-owned files and hunks; existing changes are not yours.
- GIT-02 MUST NOT overwrite, revert, format, stage, or commit unrelated changes. If another change overlaps the required hunk and safe integration is unclear, STOP that edit and report the conflict. Continue independent work.
- GIT-03 MUST recheck status and diffs after changes and immediately before staging or committing. A file you edited can also contain changes from another contributor.
- GIT-04 SHOULD use isolated branches or Git worktrees for parallel tasks when authorized. Do not switch an occupied worktree or create/delete worktrees without checking their status and the task's authorization.

## Branches and commits

- GIT-05 SHOULD use protected `main`, short-lived branches, reviewed pull requests, and squash merging for independent changes. Use `feat/`, `fix/`, `perf/`, `refactor/`, `test/`, `docs/`, `chore/`, or `security/` branch prefixes.
- GIT-06 MUST commit only when the user explicitly authorizes a commit. Push, merge, tag, release, and publish each require applicable authorization. Do not infer permission to push from permission to commit.
- GIT-07 MUST stage explicit task-owned paths with `git add -- <path>` only after verifying ownership of all changes in those paths. For mixed-ownership files, stage only verified task-owned hunks; if uncertain, STOP. If unrelated changes are already staged, do not commit or manipulate the other contributor's index; use an authorized isolated workflow or report the blocker.
- GIT-08 MUST inspect the complete staged diff before committing. Run required checks. Use Conventional Commits: `type(scope): imperative summary`. Explain breaking changes in the footer or `!` marker. Keep commits focused.
- GIT-09 MUST NOT bypass hooks or branch protections. Do not sign on another person's behalf or fabricate authorship, reviews, or validation results.

## Prohibited autonomous operations

GIT-10 MUST NOT run the following in a shared worktree or use equivalent destructive operations:

```text
git add .
git add -A
git reset --hard
git checkout .
git restore .
git clean -fd
git stash
git commit --no-verify
git push --force
git push --force-with-lease
```

Also prohibited: deleting untracked files you do not own, rewriting shared history, discarding someone else's hunks, or automatically resolving conflicts in unrelated files.

## Review and recovery

- GIT-11 MUST prefer read-only inspection for PR reviews. Use `git show`, `git diff`, `gh pr view`, or `gh pr diff`; do not switch branches unless authorized.
- GIT-12 MUST NOT start a rebase or merge that can affect shared work without authorization. If an authorized operation conflicts with changes outside your scope, STOP; do not discard other changes. Abort only if the operation is yours and aborting is safe.
- GIT-13 SHOULD use `git revert` for rollback of published commits. Do not rewrite remote history.
- GIT-14 MUST verify final status and diff; report remaining changes and conflicts accurately. For authorized commits, report the actual commit hash. Report push or PR status only after confirmation.

## Official references

- <https://github.com/earendil-works/pi/blob/main/AGENTS.md>
- <https://git-scm.com/docs/git-status>
- <https://git-scm.com/docs/git-worktree>
- <https://docs.github.com/en/get-started/using-github/github-flow>
- <https://www.conventionalcommits.org/en/v1.0.0/>
