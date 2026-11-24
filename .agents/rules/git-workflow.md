# Git Workflow Rules

## Commit Message Format

```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci

## Pull Request Workflow

When creating PRs:

1. Read the full commit history, not only the latest commit.
2. Use `git diff [base-branch]...HEAD` to see all changes.
3. Write a summary that says what changes for the reviewer.
4. Include the commands you ran to verify the change.
5. Push with `-u` when the branch is new.

## Feature Implementation Workflow

1. Plan the change and name the data shape before writing code.
2. Write the test first.
3. Review the diff before committing.
4. Commit in conventional format.

## Branch Naming

- `feature/` - New features
- `fix/` - Bug fixes
- `refactor/` - Code refactoring
- `docs/` - Documentation changes
