# Layer 7: third-party `pi-test-harness`

## Verdict

`@marcfargas/pi-test-harness@0.6.1` is **not compatible with pi 0.85.1** and is **not a
dependency** of this repo. Layer 7 keeps the verdict as a runnable, opt-in gate instead of a
package dependency.

## The three breaks, in order

Reproduced on this machine against a clean temp install of
`@earendil-works/pi-coding-agent@0.85.1`, `@earendil-works/pi-ai@0.85.1`,
`@earendil-works/pi-agent-core@0.85.1`, and `@marcfargas/pi-test-harness@0.6.1`.
Line numbers are from the published `dist/`.

**1. Import-time export rename (blocks everything).** `dist/session.js:15` imports
`{ getModel } from "@earendil-works/pi-ai"`. pi 0.85.1 exports `getModel` from the `/compat`
subpath only. Observed:

```
SyntaxError: The requested module '@earendil-works/pi-ai' does not provide an export named 'getModel'
    at #asyncInstantiate (node:internal/modules/esm/module_job:455:21)
```

This is the break the gate asserts. Because `index.js` re-exports `./session.js`, the package root
is unimportable, so no subpath export of `createMockPi` survives through the `exports` map either.

**2. Private session field rename (silently skips the auth bypass).** `dist/session.js:54` reads
`session._modelRegistry` and patches `getApiKey` on it. pi 0.85.1's `AgentSession` exposes
`modelRuntime` (`_modelRegistry` appears nowhere in the installed package). The harness guards the
block with `if (origModelRegistry)`, so the miss is silent until the first prompt:

```
Error: No API key found for openai.

Use /login to log into a provider via OAuth or API key.
```

**3. Agent field rename (silently leaves the real provider in place).** `dist/session.js:158` writes
`session.agent.streamFn = streamFn`. On 0.85.1 the `Agent` field is `streamFunction`
(`streamFn` is only an `AgentOptions` constructor key), so the assignment lands on a stray property
and the playbook is never used. Observed, with break 2 patched:

```
OpenAI API error (401): {"message":"Incorrect API key provided: test-key...","code":"invalid_api_key"}

Playbook not fully consumed after run() completed.
  Consumed 0 of 1 action(s).
```

With all three patches applied, a one-turn playbook ran green (assistant message `hi`, no network).
Upstream PR #10 in `marcfargas/pi-test-harness` fixes breaks 1 and 2 only and is unmerged
(checked 2026-09-15, not re-verified here). Break 3 has no upstream fix.

## What works unpatched (both MIT)

- **`createMockPi`** (`dist/mock-pi.js`). A `pi` PATH shim backed by a file queue. Its module
  imports only `node:*` builtins, so it loads on 0.85.1. Verified working here: a queued
  `{ output: "Hello from agent" }` was returned by spawning `pi -p hi`, with `callCount() === 1`.
- **The `verifySandboxInstall` pattern** (`dist/sandbox.js`): `npm pack` → temp install →
  `DefaultResourceLoader` load → resource counts. The pattern has no native equivalent here and
  the module is not needed to reuse it. **Correction to an earlier reading of this package**,
  verified against the code: `verifySandboxInstall` itself does *not* work unpatched. `dist/sandbox.js:15`
  imports `./session.js` and line 139 calls `createTestSession`, so the module inherits break 1.
  Loading it directly by file path fails with the same `getModel` `SyntaxError`.

## Why it is not a dependency

- Two of the three breaks are private-internal renames (`_modelRegistry`, `agent.streamFn`) on pi
  internals that have already been renamed twice in seven months. A pinned harness would break
  again on the next pi bump.
- The upstream fix PR is unmerged, so there is no released version to track.
- Nothing in the harness is load-bearing for layers 1 through 6. `tests/support/session.mjs` uses
  the native faux-provider path (grounding F2/F3), which is version-stable because it only touches
  public SDK exports.
- Both viable pieces are small and MIT-licensed, so they are vendorable if a layer ever needs a
  `pi` subprocess shim or a packed-install check.

## Running the gate

Default (no network, one skipped test):

```
node tests/runner.mjs --layer 7
```

Live check, which installs the pinned versions into a temp dir and asserts break 1 still
reproduces (about 2 seconds with a warm bun cache):

```
PSTACK_VERIFY_PI_TEST_HARNESS=1 node tests/runner.mjs --layer 7
```

The live check fails the suite if the import starts succeeding. Treat that as "the verdict is
stale", not as a bug in the test, and rewrite this README before re-pinning.
