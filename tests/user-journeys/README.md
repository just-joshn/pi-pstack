# User journeys (layer 8)

User-perspective tests. Each journey drives pi-pstack through the surfaces a user has (slash
commands, tool calls, UI notifications and status, files on disk) over the fake Pi host shared with
the acceptance run. No network, no real Pi session, no real child model.

```
npm run test:journeys     # the whole project
npx vitest run --project user-journeys
npx vitest run --project user-journeys -t "install-and-orient"
```

## Behavior units

A behavior unit is one observable thing the surface can do. Units are derived at runtime from the
loaded surface, never hand-listed, so a new command or a new tool action cannot escape the contract:

- one unit per registered slash command, `command:/<name>`;
- for a tool whose `action` schema names choices, one unit per choice, `tool:<name>#<choice>`;
- otherwise one unit, `tool:<name>`.

Action choices come from an `enum` array, an `anyOf`/`oneOf` array of `{ const }` or
`{ enum: [x] }` variants, or a string `description` of `a | b | c` tokens. `buildInventory` in
`inventory.mjs` owns this; the guards in `coverage.mjs` keep it honest (at least 50 units, 40
commands, 12 tool units).

## The two limbs

`summarizeCoverage` reports both limbs and the gate passes on OR:

- **Limb A (behavior).** At least 80% of the behavior inventory was observed: `covered / total >= 0.8`.
- **Limb B (journeys).** Every critical journey in the registry ran exactly once, passed, and
  recorded at least one unit.

Anti-vacuum guards sink the verdict regardless of the limbs: inventory floor, command floor, tool
floor, every journey ran exactly once, every journey observed at least one unit, and no orphan
journeys. A failed journey fails limb B but not limb A; a journey that never ran fails the verdict.

The one-line report is stable and machine-checkable:

```
user-journeys: journeys=16/16 behavior=92/92 (100.0%) threshold=80% limbA=PASS limbB=PASS verdict=PASS
```

## The bench

`createJourneyBench({ entry })` builds the inventory once from a probe host, then runs each journey
against a fresh host with its own temp HOME and cwd.

`bench.runJourney(journey)` makes a fresh temp root, emits `session_start`, asserts the fresh host
registered the same tools and commands as the probe host (duplicate registration throws), builds
the user facade, runs the journey, and always tears down: `session_shutdown` (clears loops and
background jobs), env and `process.argv[1]` restores, temp-root removal. A failed journey still
contributes whatever it observed.

`bench.observed`, `bench.results`, and every facade accessor return copies.

## User facade

The only invocation surface a journey uses.

```js
await user.tool(name, params)        // records the unit before executing, so a refused call counts
await user.command(name, args = "")  // records command:/<name> before dispatching
user.message() / user.messages()     // last / all recorded messages
user.status(key) / user.statuses()
user.notifications() / user.entry(type) / user.entries()
user.activeTools() / user.execCalls()
user.registrations()                 // every registerCommand name, in order
user.commands() / user.tools()       // registered names (copies)
user.path(rel) / user.read(rel) / user.write(rel, text) / user.exists(rel)
user.git(argv)                       // real git in the journey cwd
user.waitFor(predicate, timeoutMs = 5000, label = "condition")
user.setExec(fn) / user.setConfirm(fn) / user.setFetch(fn)
user.stubChild(source) / user.setSessionFile(path)
user.installFakeGit(mode) / user.installFakeGh(fixtures)
user.emitSessionStart() / user.emitBeforeAgentStart(prompt, sys) / user.emitInput(text, source)
user.emitToolCall(name, input) / user.emitAgentSettled() / user.emitSessionShutdown()
```

`user.tool` records `tool:<name>#<params.action>` when that unit exists, else `tool:<name>`. The
`tool_call` emitters return the handler results; a readonly coercion mutates the same `input`
object the caller passed. `installFakeGit("real")` (or `"passthrough"`) shims to the real git;
the default fake only creates the worktree directory.

## Adding a journey

1. Pick the workstream file in `journeys/` (`routing` J2-J5, `orchestrate` J6-J9, `tooling` J10-J13,
   `knowledge` J14-J16) and append to its `JOURNEYS` array.
2. Write `{ id, title, critical: true, surfaces, run }`. `id` is kebab-case and unique; `title` is
   a user-voice sentence; `surfaces` are slugs from `spec/surfaces.tsv`.
3. Use only the facade. Assert user-visible outcomes with `node:assert/strict` against literal
   expected values.
4. Record at least one unit so the coverage contract sees the journey exercised the surface.
5. Keep `run` under 50 lines by extracting private step helpers in the same file; conformance
   counts every function.
6. Verify with a name-pattern run plus `npm run conformance`. The full suite and the coverage
   verdict are the parent's job after all workstreams land.

## Files

`harness.mjs` bench + facade + recorder; `inventory.mjs` unit derivation; `coverage.mjs` contract
math and report; `registry.mjs` the journey table; `journeys/*.mjs` one file per workstream. The
node:test entry is `tests/layers/08-user-journeys/user-journeys.test.mjs`.
