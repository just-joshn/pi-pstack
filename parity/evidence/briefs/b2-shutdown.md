# B2: stop foreground Tasks when the parent Pi session shuts down

Repo: `/Users/josh-desktop/.pi/agent/pstack/pi-pstack` (branch `pi-package-0.15.5`). Edit only `extensions/pstack-agents/`. Commit your change on this branch (`git add` only the files you changed). Do not push, no PR, do not touch anything under `~/.pi/agent` outside this repo, never kill processes you did not start. Other workers use separate worktrees.

## Settled design (the coordinator already ran repro, grounding, and the design comparison)

Evidence: `/tmp/arena-b1-foreground-shutdown-20260925T010316Z/grounding.md` and captures in `/tmp/b1-quit-retry/`. Measured: background runs survive `/quit`, double Ctrl+C, tmux window close, RPC parent SIGTERM, and quit during `SubagentAwait`; each completes after resume with exactly one notice. Defect: a foreground Task keeps running after its parent quits (run `836658b7…` stayed `running`).

Implement the grounding doc's first alternative, "Lifecycle policy in `index.ts`": in `session_shutdown` (and when `session_start` displaces an existing store), take `latestRuns(ctx.sessionManager.getBranch())`, call `store.interrupt(id)` for each nonterminal latest launch whose `runInBackground` is false, then close watchers even if an interrupt throws. Idempotent: clear the module's store reference before async work. Invariants 1 to 6 in the grounding doc hold. Do not run the Feature playbook's `how` or `architect` steps (mark them `skip: settled by coordinator, see grounding.md`). Write the code yourself; do not spawn Tasks.

Tests (bun:test, `extensions/pstack-agents/index.test.ts`, real runner processes like the existing lifecycle tests): shutdown interrupts a running foreground launch; leaves a running background launch running and it later completes; calling the shutdown hook twice is a no-op the second time; watchers close when an interrupt throws. Each must fail before your change where the behavior is new.

Real proof: repeat the grounding doc's foreground `/quit` repro (isolated `PI_CODING_AGENT_DIR`, package installed from this repo, all other `PI_*` unset) and show the foreground run ends `stopped` after quit, and a background run in the same session still completes after resume.

Checks: `bun test extensions` (report pass/fail; the baseline is 69 on this branch) and `npm run typecheck` (baseline 7 errors on this branch; report only new ones).

Reply with: commit sha and subject, tests added, check outputs, real-proof output lines with paths.
