# Third-party licenses

Much of this package is derived from two plugins in [cursor/plugins](https://github.com/cursor/plugins) at commit [`41e4009`](https://github.com/cursor/plugins/tree/41e400932eca14f289e7db717a70455256b6d388). Both are under the MIT License. Their notices are kept here, unchanged:

- [`pstack.LICENSE`](./pstack.LICENSE): pstack 0.15.48, copyright (c) 2026 Lauren Tan.
- [`cursor-team-kit.LICENSE`](./cursor-team-kit.LICENSE): Cursor Team Kit 1.2.0, copyright (c) 2026 Cursor.

## What comes from where

From Cursor Team Kit:

- The skills `check-compiler-errors`, `control-cli`, `control-ui`, `deslop`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`, `loop-on-ci`, `make-pr-easy-to-review`, `new-branch-and-pr`, `pr-review-canvas`, `review-and-ship`, `run-smoke-tests`, `thermo-nuclear-code-quality-review`, `verify-this`, `weekly-review`, `what-did-i-get-done`, `workflow-from-chats` in `src/skills/`, with the PR review canvas assets.
- The agents `ci-watcher` and `thermo-nuclear-code-quality-review` in `src/agents/`.
- The rules `no-inline-imports` and `typescript-exhaustive-switch` in `src/reference/rules/`.

From pstack, everything else that is ported:

- Every other skill in `src/skills/`, with its references, templates and scripts, including the poteto-mode playbooks, `worker.md`, `watch-pr`, `worktree-audit.sh`, `log.sh` and the statechart tools.
- The agents `poteto-agent` and `comment-sicko` in `src/agents/`.
- The guide in `src/docs/guide/`, with its images.
- The Benny automation pack in `src/automations/benny/`.

Each of those files is upstream's, changed only where a sentence names a Cursor mechanism. The extension code, tests and the rest of the repository are this package's own, under the root `LICENSE`.
