# Testing Rules

## Minimum Test Coverage: 80%

Test types, where the project has the surface:

1. **Unit tests** for pure functions, parsers and predicates.
2. **Integration tests** for process, file and protocol boundaries.
3. **End-to-end tests** only when there is a user flow to drive. This repository has none yet.

## Test-Driven Development

Default workflow:

1. Write the test first (RED).
2. Run it and watch it fail for the expected reason.
3. Write the smallest implementation that passes (GREEN).
4. Run the full suite and the coverage gate.
5. Refactor with the test as the safety net.

## Edge Cases to Test

Every input boundary needs:

- [ ] Null and undefined
- [ ] Empty arrays and strings
- [ ] Wrong types
- [ ] Boundary values (min and max)
- [ ] Error conditions

## Test Quality Checklist

- [ ] Tests are independent (no shared state)
- [ ] Test names describe the behavior, not the function name
- [ ] Use a real dependency where it is cheap and local; mock only services you cannot run
- [ ] Both the happy path and the error path are covered
- [ ] No flaky tests
