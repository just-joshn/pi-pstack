# A2: full re-audit of the pi-pstack package at f447ec2 (read-only)

You are read-only. Write exactly one file, your report, at the path given in your task prompt (use bash `cat > file` for that single write). Change nothing else. Do not run Pi sessions; reading code, docs, and running `npm run check` in a temp copy is fine.

Package: `git -C /Users/josh-desktop/.pi/agent/pstack/pi-pstack archive f447ec2 | tar -x -C $(mktemp -d)` gives you a clean copy (or read the repo at that commit; the working tree may have extra untracked evidence files). Pi docs (authoritative, version 0.87.1): `/Users/josh-desktop/.pi/agent/install/releases/0.87.1/node_modules/@earendil-works/pi-coding-agent/docs/` (read ALL of it that bears on packages, extensions, skills, settings, sessions, TUI, RPC UI, security, CLI), exact types `../dist/core/extensions/types.d.ts`, examples `../examples/extensions/`. Parity target: Cursor pstack 0.15.5 vendored at `parity/upstream/0.15.5/pstack/`; Cursor CLI bundle `~/.local/share/cursor-agent/versions/2026.09.18-9a7762b/index.js` (grep `TaskToolCallArgsProto`, `ShellArgs`, `AwaitArgs`).

The previous audit is `parity/a1-compliance-report.md`; its 13 fixes were applied since. Do not trust that; re-derive.

Report sections:
1. **Rule matrix.** Every normative rule in the Pi docs and types that applies to this package, with citation, verdict COMPLIES / VIOLATES / N/A, and `file:line` evidence from the code at f447ec2. Include lifecycle (nothing started in a factory; session_start / idempotent session_shutdown), reload safety, tool contracts (TypeBox, content+details, throw on failure, truncation, withFileMutationQueue, executionMode, nested usage), UI and mode guards, state storage and branch reconstruction, command-only APIs, before_agent_start use, tool_call blocking, skill frontmatter/naming/relative paths, package manifest and dependencies, config locations, security notes.
2. **A1 fix verification.** For each of A1's 13 ranked fixes: FIXED / PARTIAL / NOT FIXED with evidence.
3. **Mechanism choice.** For each thing the package does, is it the best documented Pi mechanism for it? Name any place where a more native Pi mechanism exists and is not used.
4. **Cursor parity.** Tool argument names and semantics vs the Cursor CLI protos (Task, Shell, Await); skill and agent text vs upstream (run `node parity/check-parity.mjs` and `node parity/full-audit.mjs` and judge whether the justification rows hold up, sampling at least 25 rows); any Cursor behavior the package lacks that Pi could support.
5. **Ranked findings.** Severity-ranked list with the smallest concrete fix each. Mark anything you could not confirm UNCONFIRMED with what you tried.

Final reply: the report path, then section 5 only.
