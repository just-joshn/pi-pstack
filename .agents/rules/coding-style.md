# Coding Style Rules

## Immutability

Create new objects instead of mutating:

```typescript
// Wrong: mutation
function updateUser(user: User, name: string): User {
  user.name = name;
  return user;
}

// Right: a new object
function updateUser(user: User, name: string): User {
  return { ...user, name };
}
```

Local mutation is fine while building a value inside one function. Shared state is not.

## File Organization

Many small files beat a few large ones:

- High cohesion, low coupling
- 200 to 400 lines typical, 800 maximum
- Extract a utility when a second caller appears
- Organize by feature, not by type

## Error Handling

Throw at the boundary where the failure happens and include the context needed to act on it. Do not
catch an error you cannot handle, and do not log and rethrow the same error.

```typescript
if (result.exitCode !== 0) {
  throw new Error(`${result.command} exited ${result.exitCode}\n${result.stderr || result.stdout}`);
}
```

## Input Validation

Validate untrusted input once, at the boundary, and return a typed value. The repository has no
validation library, so use a type guard.

```typescript
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
```

## Code Quality Checklist

Before marking work complete:

- [ ] Code is readable and well named
- [ ] Functions are small (<50 lines)
- [ ] Files are focused (<800 lines)
- [ ] No deep nesting (>4 levels)
- [ ] Errors carry context
- [ ] No `console.log` outside the CLI boundary
- [ ] No hardcoded secrets or machine-specific paths
- [ ] Immutable patterns used for shared state
