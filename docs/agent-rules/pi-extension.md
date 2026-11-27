# Pi extension rules

Scope: Extension factories, tools, commands, events, session state, UI, and Pi package integration. Verify API details against the installed Pi version.

## Registration and compatibility

- PI-01 MUST export a default factory receiving `ExtensionAPI`. Use public APIs of the supported SDK. Current namespace: `@earendil-works/pi-coding-agent`; do not migrate a legacy SDK without authorization and compatibility tests.
- PI-02 MUST keep module loading and factory registration cheap. Avoid eager network access, subprocesses, repository scans, and heavy initialization unless essential. Pi awaits asynchronous factories. Prefer initialization on demand.
- PI-03 MUST register unique, stable names for tools, commands, and persistent entry types. Document parameters, output, side effects, limits, and user-visible commands. Do not register overlapping names unintentionally.
- PI-04 MUST NOT require a build step solely to load TypeScript: Pi supports source loading through jiti. For source packages, declare entry paths in `package.json` under `pi.extensions` or use documented discovery conventions.
- PI-05 MUST declare imported host-provided packages in `peerDependencies` with `"*"`, per current Pi package guidance. These are `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox`. Pin tested versions as development dependencies where needed. Do not put host-provided packages in runtime `dependencies` or bundle them. Declare all other runtime imports in `dependencies`. Document the tested Pi range separately.

## Lifecycle and state

- PI-06 MUST scope state and resources to their owner: call, session runtime, active branch, or explicitly shared service. Do not use module globals for session-specific mutable state.
- PI-07 MUST initialize or restore session state in `session_start`. Use documented session entries (`pi.appendEntry`) or tool result `details` for state that should persist; restore branch-specific state from the active branch. Handle tree navigation when branch state changes.
- PI-08 MUST release session-owned listeners, timers, watchers, streams, workers, subprocesses, and sockets during `session_shutdown`. Cleanup must be idempotent and bounded. Do not rely on shutdown alone for durable writes.
- PI-09 MUST NOT reuse stale session-bound objects after reload or session replacement. After `ctx.reload()`, the old call frame may still run; do not access invalidated state. Follow the SDK's `withSession` rules for replacement callbacks.

## Tools

- PI-10 MUST use JSON Schema-compatible parameter schemas, preferably TypeBox when supported by the installed SDK. Enforce domain constraints and authorization in execution code. Current Pi validation may coerce arguments; TypeBox-only refinements, codecs, and custom formats are not enforced by Pi's schema validator.
- PI-11 MUST propagate the supplied abort signal through cancellable I/O, subprocesses, waits, and loops. Use progress callbacks only when useful, with bounded update frequency. Release resources on success, failure, cancellation, and timeout.
- PI-12 MUST assume tools from a single assistant message can execute concurrently. Protect shared mutable state and conflicting writes. Set `executionMode: "sequential"` when concurrent execution is unsafe and verify the installed SDK supports it. Do not assume this coordinates separate Pi processes.
- PI-13 MUST return truthful, concise model-readable `content`; use `details` for renderer/session data and `outputSchema` with matching `structuredContent` for supported structured tool contracts. Throw errors for failed execution or return `isError: true` when the SDK supports useful structured failure data. Never hide failure in a success message.
- PI-14 MUST bound raw output collection and truncate model-facing text. Default ceiling: 50 KB and 2,000 lines, whichever is reached first. Prefer tighter task-specific limits. Use Pi truncation helpers, reserve space for the truncation notice, and report truncation plus a safe path or retrieval method for remaining output when available. Never persist secrets merely to provide complete output.

## Interface modes

- PI-15 MUST guard dialogs and notifications with `ctx.hasUI`. Guard terminal-only behavior with `ctx.mode === "tui"`. RPC has UI support but not all TUI functionality. Print and JSON modes cannot prompt.
- PI-16 MUST define noninteractive behavior. If an operation requires authorization that is unavailable, deny it without side effects. Never corrupt JSON/RPC stdout with ad hoc logging.
- PI-17 MUST keep renderers fast and side-effect-free except for documented UI lifecycle behavior. Render from typed structured data; do not parse display text to reconstruct state. Respect configured keybindings and UI width.

## Verification

- Test registration, applicable run modes, cancellation, parallel calls, session restoration, branch navigation, reload, cleanup, and packaged installation as required by [testing.md](testing.md).

## Official references

- <https://docs.pi.dev/latest/extensions>
- <https://docs.pi.dev/latest/packages>
- <https://docs.pi.dev/latest/how-pi-works>
