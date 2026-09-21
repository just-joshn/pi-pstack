# Changelog

## Unreleased

### Changed
- The package is the Pi-native pstack surface: `subagent`, `pstack-slash`, and `todo` extensions, skills that call the `subagent` tool, `/setup-pstack` writing `~/.pi/agent/AGENTS.md`, and four agents (`poteto-agent`, `Comment Sicko`, `reviewer`, `worker`).
- `npm test` is `check-port`, conformance over `tests/`, and Vitest unit tests for slash rewrite, bundled agents, and the `pi` manifest.
- The previous `pstack_*` tool twin, `port/`, `spec/`, `compat/`, and hosted services are removed. Playbook orchestration uses Pi's built-in subagent, slash, and todo extensions, matching `~/.pi/pstack`.
