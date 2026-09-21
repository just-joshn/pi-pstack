# Coding Style Rules

## Scope

These rules govern project-owned test and harness code under `tests/`. Enforce them with `npm run conformance` (zero-dependency checker, wired into `npm test`).

The native pstack surface (`extensions/`, `skills/`, `agents/`, `automations/`, `docs/`) matches the live Pi package at `~/.pi/pstack`. Do not restyle those files to this document. Their gate is `node skills/poteto-mode/scripts/check-port.mjs`, which rejects Cursor-only tokens, broken skill frontmatter, slash-alias drift, and dead relative links. `node tests/native-parity.mjs` compares the surface to `~/.pi/pstack` when that tree is present.

## Immutability (CRITICAL)

ALWAYS create new objects, NEVER mutate:

```javascript
// WRONG: Mutation
function updateUser(user, name) {
  user.name = name  // MUTATION!
  return user
}

// CORRECT: Immutability
function updateUser(user, name) {
  return { ...user, name }
}
```

## File Organization

MANY SMALL FILES > FEW LARGE FILES:
- High cohesion, low coupling
- 200-400 lines typical, 800 max
- Extract utilities from large components
- Organize by feature/domain, not by type

## Error Handling

ALWAYS handle errors comprehensively:

```typescript
try {
  const result = await riskyOperation()
  return result
} catch (error) {
  console.error('Operation failed:', error)
  throw new Error('User-friendly error message')
}
```

## Input Validation

ALWAYS validate user input at system boundaries. Trust internal types.

## Code Quality Checklist

Before marking work complete:
- [ ] Code is readable and well-named
- [ ] Functions are small (<50 lines)
- [ ] Files are focused (<800 lines)
- [ ] No deep nesting (>4 levels)
- [ ] Proper error handling
- [ ] No console.log statements
- [ ] No hardcoded secrets
- [ ] Immutable patterns used

# Git Workflow Rules

## Commit Message Format

```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci

## Pull Request Workflow

When creating PRs:
1. Analyze full commit history (not just latest commit)
2. Use `git diff [base-branch]...HEAD` to see all changes
3. Draft comprehensive PR summary
4. Include test plan with TODOs
5. Push with `-u` flag if new branch

## Branch Naming

- `feature/` - New features
- `fix/` - Bug fixes
- `refactor/` - Code refactoring
- `docs/` - Documentation changes

# Testing Rules

`npm test` runs `check-port`, conformance over `tests/`, and the Vitest unit project. `bun test skills/poteto-mode/scripts` runs the orch and watch-pr suites.

Test names describe behavior. Tests stay independent. Both happy path and error paths are required for new helpers.

# Security Rules

## Mandatory Security Checks

Before ANY commit:
- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] All user inputs validated at boundaries
- [ ] Error messages don't leak sensitive data

## Secret Management

```typescript
const apiKey = process.env.API_KEY
if (!apiKey) throw new Error('API_KEY not configured')
```
