# Testing and verification

Scope: All changes to executable behavior, bug fixes, interfaces, and tests. Default runner: Vitest with V8 coverage. Use the project's configured equivalent if different.

## Test design

- TEST-01 MUST define observable acceptance criteria. For a bug fix, reproduce the bug and add a regression test when practical; when practical, verify the test fails for the intended reason before the fix.
- TEST-02 MUST cover changed behavior, meaningful boundaries, and expected failures. Test public results and side effects rather than private implementation details. Do not merely assert that a mock was called when the contract requires an outcome.
- TEST-03 MUST keep tests deterministic and independent. Control time, random seeds, and environment. Use isolated temporary directories and restore mocks, listeners, timers, and resources. Do not rely on sleep-based timing for synchronization.
- TEST-04 MUST NOT call paid or live model APIs, access production data, or require real credentials in normal CI. Mock external providers and use local test servers or fixtures. Use real filesystem/subprocess behavior when it is the contract under test.
- TEST-05 MUST NOT delete valid tests, weaken assertions, skip failing tests, accept snapshots blindly, or reduce thresholds to make CI pass. Explain legitimate contract changes and review snapshot diffs.
- TEST-06 SHOULD use unit tests for pure logic, integration tests for boundaries, contract tests for schemas, real Pi smoke tests for registration/runtime behavior, and property/stress tests for invariants and concurrency where relevant.

## Pi regression matrix

Run applicable scenarios for changed behavior; a new extension must cover every relevant row before release.

| Scenario | Required observable result |
| --- | --- |
| Startup and registration | Loads without unexpected side effects; intended names registered once |
| New/resumed session | Correct state initialization/restoration |
| Fork/tree navigation | State reflects active branch; no unrelated session data |
| Reload/shutdown | No stale state, duplicate handlers, or unintended retained resources |
| Invalid or oversized input | Rejected before side effects or safely bounded |
| Unauthorized operation | Denied; no protected action occurs |
| Parallel and conflicting calls | Race-free state and correct ordering where required |
| Abort and timeout | Work stops within its contract; resources released |
| Tool result and schema | Valid content, structured data, errors, and truncation notice |
| Network/filesystem/process failure | Actionable error; no corrupted state or leaked credentials |
| Print/JSON/RPC/TUI modes | Correct mode behavior; no missing authorization or protocol corruption |
| Repeated execution | No unintended memory or resource retention |
| Packaged installation | Loads under supported Pi with only declared runtime/host dependencies |

## Coverage policy

These are project defaults, not Vitest or Pi requirements. Adopt in CI with an explicit baseline; do not silently lower an existing stricter policy.

| Metric | Minimum | Target |
| --- | ---: | ---: |
| Lines | 85% | 95% |
| Branches | 80% | 90% |
| Functions | 90% | 95% |
| Statements | 85% | 95% |
| Changed-code coverage (if diff coverage is configured) | 90% | 95% |

- TEST-07 MUST test each identified security-sensitive decision path. Coverage percentages do not prove correctness. Include untested source in coverage scope. Use reviewed exclusions only for genuinely unreachable/generated code or justified infrastructure.
- TEST-08 MUST use representative benchmarks for performance-sensitive changes. See [performance.md](performance.md); do not make functional tests depend on noisy wall-clock thresholds.

## Validation sequence

1. Inspect actual scripts and dependencies. Run focused tests for changed behavior.
2. Run configured format/lint/typecheck, full applicable test suite, and coverage. Run relevant integration/contract/security tests. Run real Pi smoke tests when changing runtime contracts or packaging.
3. If a check fails, investigate and fix task-related failures. Rerun affected checks after edits. Preserve unrelated failures and report them separately.
4. Review the complete diff for scope, behavior, test assertions, and missing failure cases. Repeat relevant checks after the final fix.
5. Report each required check as passed, failed, or not run with its reason. Do not claim success based on an unexecuted command.

## Official references

- <https://vitest.dev/guide/>
- <https://vitest.dev/guide/coverage.html>
- <https://vitest.dev/guide/mocking.html>
- <https://docs.pi.dev/latest/extensions>
