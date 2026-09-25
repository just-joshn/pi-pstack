# Changelog

## 0.15.5-pi.1

This release replaces the whole repository with a Pi package built from pstack 0.15.5 (cursor/plugins `12d587d`). Nothing from the earlier `0.15.2-pi.1` tree remains. `parity/provenance.mjs` checks that every file traces to this port or to the vendored upstream.

- Pi package manifest under `pi` in `package.json`: five extensions and the `skills/` directory. Pi's own packages and `typebox` are peer dependencies with a `*` range. `commander` is the one runtime dependency.
- The `pstack-agents` extension provides `Task`, `SubagentAwait`, `Shell`, `Await`, `CreateGoal`, `UpdateGoal`, and `/goal`. It replaces the earlier `extensions/subagent` runtime. `Task` accepts the fields of Cursor's `TaskToolCallArgs` and nothing else.
- Agents ship in the package's `agents/` directory. A user agent in `~/.pi/agent/agents` or a trusted project agent in `.pi/agents` overrides a package agent with the same name.
- Tool failures throw, so Pi marks them as failed results. Long `Task` and `Shell` output is truncated with Pi's helpers, and the result names the full transcript or log.
- Subagent usage counts toward the parent session's totals once for each run attempt.
- A background run survives a Pi quit, and its completion notice arrives once after resume. A foreground run stops when its session shuts down.
- Model scope moves from `settings.json` to `extensions/pstack-agents.json` in Pi's agent directory.
- Skill text uses skill-relative paths. Paths into Pi's agent directory use `~/.pi/agent` in prose and `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}` in commands.
- `parity/lint-package.mjs` lints the `npm pack` contents. `npm run check` runs it with the type check, the tests, and the parity checks.
