# Historical findings for U3b planning

## Question
What explicit historical constraints explain the current package/runtime shape, and what should the U3b fixes preserve or avoid?

## Code anchor
- `extensions/pstack-agents/agents.ts`: `parseAgentFiles`, `parseAgentDefinition`, `parseModelScope`, `withGuardExtensions`, `loadModelScope`, `parseTaskInput`.
- `extensions/pstack-agents/index.ts`, `runs.ts`, `contracts.ts`, `runner.mjs`: Task/Shell/Await/goal tool handling, run records, child process behavior.
- `extensions/pstack-guards.ts`, `pstack-mode.ts`, `todo.ts`, `agents/poteto-agent.md`.
- Target branch is `u3-runtime` at `70fc1e6` before edits. Its latest commits are `70fc1e6`, `eaac7f8`, `196af18`, `4e9d117`, `b2f1222`.

## Direct evidence

- PR #14 body (created and merged 2026-09-21) says the package should use “Pi's own subagent, slash, and todo extensions” and “not a second host.” It kept a thin harness because old tests “described tools that no longer exist.” No linked issues, reviews, or substantive PR comments exist. Source: `https://github.com/just-joshn/pi-pstack/pull/14`.
- `parity/decisions-package.tsv:3` says model scope moves to `<agentDir>/extensions/pstack-agents.json` because `settings.json` has no documented extension keys. Row 6 records the isolated package spike: skills load, but guards/agents do not because they resolve from the agent dir; the playbook read was not blocked and agent resolution returned `Unknown agent`. Row 8 says package paths vary and child skills need an absolute path. Row 13 records the operator requirement to map every Cursor mechanism to documented Pi behavior and replace inventions after A1 audit.
- `parity/PACKAGE-PLAN.md:13,23-25` makes isolated package install the done predicate and explicitly calls child skills/guards/agents an unknown; U3 calls for package-relative agents/guards and agent-dir extension config.
- `/tmp/pkg-briefs/a1-compliance-report.md:7,37,40,48,52,54,67,76,78,80-83,95-106` records audit findings and recommendations. It says audit was static only. It identifies missing package agents, ignored `is_background`, raw `<pstack>`, config-path mismatch, guard path, returned `isError`, unbounded output, missing usage, missing todo serialization, and mismatches in CLI args. Its test/fix recommendations are not runtime proof.
- Cursor bundle check in the parent session found `TaskToolCallArgsProto` includes optional field 12 `machine`; Pi provides no equivalent. The item 11 implementation should retain the arg and reject it clearly at Task execution.
- The upstream Cursor 0.15.5 `agents/poteto-agent.md` sets `is_background: true` and asks the child to read the `poteto-mode` skill then a named `principle-*` leaf.
- `eaac7f8` and `70fc1e6` address Await-abort detachment; `parity/decisions-package.tsv:14-15` records separate quit-survival and await behavior. The user brief explicitly assigns quit survival in `runs.ts`/`runner.mjs` lifecycle to another worker and asks U3b to keep those files minimal.

## Issue tracker
`gh issue list --state all` showed only #15 and #16. Both concern adjacent topics (model diversity, oversized Reflect prompts), were created after PR #14, and have no links to the target commits. No ticket directly explains the listed runtime mismatches. Some later symbol searches hit the GitHub API rate limit.

## Long-form docs
The A1 audit, U3 package plan, and package decision ledger were read in full. The local docs confirm the stated acceptance criteria and package-path findings, not that a particular fix has passed.

## Gaps
Slack CLI `auth.test` returned `not_authed`, with no Slack tokens or MCP; no chat search is available. No matching infra, error-tracking, analytics, Notion, or ticket CLIs were installed. The package plan and audit are historical records, not fresh verification. Quit survival remains out of scope and unresolved here.

## Planning constraints
Preserve Cursor 0.15.5 names, prompts, precedence, explicit Task override, branch-backed todo state, and documented Pi boundaries. Change only the listed runtime mismatches; use `getAgentDir()` for agent paths and package-relative paths for packaged resources. Do not add a fallback to `settings.json`, claim local worktrees or guards are a sandbox, alter quit-survival lifecycle, or open a PR. Use `--skill <path>` or another documented skill mechanism, not `<pstack>` expansion.