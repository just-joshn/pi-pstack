# Security Rules

## Mandatory Security Checks

Before ANY commit:

- [ ] No hardcoded secrets (API keys, passwords, tokens)
- [ ] All untrusted input validated at the boundary
- [ ] Error messages don't leak sensitive data
- [ ] Authentication and authorization verified, where the project has them
- [ ] SQL injection prevented with parameterized queries, where the project has a database
- [ ] XSS prevented with sanitized HTML, where the project renders HTML
- [ ] CSRF protection enabled, where the project has a browser session
- [ ] Rate limiting on public endpoints, where the project serves them

## Secret Management

```typescript
// Never hardcode a secret.
const apiKey = process.env.API_KEY;
if (apiKey === undefined) throw new Error("API_KEY is not set");
```

## Security Response Protocol

If a security issue is found:

1. Stop.
2. Run a dedicated security review of the change.
3. Fix critical issues before continuing.
4. Rotate any exposed secret.
5. Search the codebase for the same pattern.
