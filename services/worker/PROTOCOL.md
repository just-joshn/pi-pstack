# Hosted worker protocol

The worker service is the hosted execution path for pstack. `services/worker`
owns the durable run record and the result stream. A caller that sets
`environment=hosted` must reach it through `PSTACK_HOSTED_URL`; there is no local
fallback, because a local child cannot reproduce the worker's durability
guarantees.

- `server.mjs` is the HTTP boundary and the run lifecycle.
- `protocol.mjs` validates the untrusted request body.
- `store.mjs` is the durable run store.
- `executor.mjs` spawns pi with the local child-runner argv shape.

## Endpoints

| Method | Path | Success | Meaning |
| --- | --- | --- | --- |
| POST | `/v1/tasks` | 202 `{runId, attempt, state}` | Accept a run and start the first attempt. |
| POST | `/v1/tasks` (repeat key) | 200 `{runId, attempt, state}` | Existing record for the same idempotency key; no second execution. |
| GET | `/v1/tasks/:runId` | 200 record | Read the durable run record. |
| POST | `/v1/tasks/:runId/cancel` | 200 record | Cancel a non-terminal run. |
| GET | `/healthz` | 200 `{status:"ok"}` | Liveness. Never requires auth. |

Failures: 400 malformed body or invalid field, 401 missing or wrong bearer
token, 404 unknown run, 409 `runId` reused with a different idempotency key,
413 body over the cap, 429 per-client request cap exceeded, 500 corrupt record
or unexpected error, 503 no token configured or the worker is at capacity.

## Request body

```jsonc
{
  "runId": "run-abc123",                 // ^[A-Za-z0-9._-]{1,64}$
  "idempotencyKey": "idem-abc123",       // non-empty, <= 200 chars
  "parentOwnership": { "sessionId": "s1", "cwd": "/repo" },
  "parentSessionCwd": "/repo",           // legacy alias for parentOwnership.cwd
  "upstreamRevision": "5bf2b15",         // default "unknown"
  "pluginVersion": "0.15.2-pi.0",        // default "unknown"
  "task": "self-contained brief",
  "role": "general",
  "model": "provider/model",
  "thinkingLevel": "high",               // string | null
  "policy": {                            // all eight axes are required
    "filesystem": "workspace-write",
    "shell": "full",
    "git": "branch-write",
    "network": "allowed",
    "integrations": "inherit",           // "none" | "inherit" | [capability, ...]
    "environment": "hosted",
    "background": false,
    "isolation": "remote"
  },
  "capabilities": ["source-control"],    // integration grants, default []
  "secretRefs": ["OPENAI_API_KEY"],      // names only, never values
  "isolation": "remote",
  "timeoutMs": 600000,                   // 1000..1800000, default 600000
  "reportSchema": null                   // optional contract for the result
}
```

Unknown top-level fields are rejected with 400. The body cap is 256 KiB. The
worker never executes a body it did not validate.

`model` must match `provider/model[:level]`, a bare alias such as
`inherit-parent`, or `auto`. A value with whitespace or shell metacharacters is
rejected with 400 before it can reach `--model`.

`parentOwnership.cwd` (and the legacy `parentSessionCwd`) must be an existing
directory inside the worker's `workspaceRoot`, which defaults to
`process.cwd()`. Both sides are realpath-resolved, so a symlink inside the root
cannot point outside it. Anything else is a 400.

A 500 response is always `{"error":"internal error"}`. The handler's real error
is written to stderr, never to the client, because filesystem and spawn errors
embed absolute host paths.

`secretRefs` names are not resolved and not logged. The request token is never
logged either.

## States

`accepted -> running -> completed | failed | cancelled | timed_out | dead`

- `accepted`: the record exists and no attempt has started.
- `running`: an attempt holds the lease.
- `completed`: exit 0; stdout and stderr are durable in the record.
- `failed`: non-zero exit or a thrown executor.
- `cancelled`: a cancel request landed.
- `timed_out`: `timeoutMs` elapsed.
- `dead`: a restart reconciled a lease that lapsed.

Terminal states are `completed`, `failed`, `cancelled`, `timed_out`, `dead`.

## Guarantees

- Idempotency. A repeat POST with the same `idempotencyKey` returns the existing
  record with the same attempt. The task is never executed twice.
- Fencing. Every execution carries an `attempt` number. A completion whose
  attempt is older than the record's current attempt is dropped, so a zombie
  worker cannot overwrite a newer attempt.
- Durable outputs. stdout and stderr are appended to
  `<stateDir>/output/<runId>.*.log` while the run executes and folded into the
  record before it reaches a terminal state. Partial output survives worker
  death.
- Reconnect and restart. A new worker over the same state dir calls
  `expireStaleLeases` at startup and marks lapsed non-terminal runs `dead`. The
  record, not process memory, is the source of truth.
- Parent shutdown. Nothing in the request lifecycle cancels a run when the
  client disconnects. A run keeps going until it completes, times out, is
  cancelled, or is reconciled dead.
- Cancellation. `POST /cancel` records `cancelled` and aborts the executor's
  `AbortSignal`.
- Late completion. A completion after a terminal state is ignored.

## Auth

Set `PSTACK_WORKER_TOKEN` on the worker and send `Authorization: Bearer <token>`.
With no configured token the worker returns 503 on every `/v1` route and runs
nothing. `/healthz` is exempt so a liveness probe can reach the process.

## Limits

Two caps protect the worker. Both apply before the request does any work.

- **Per-client request cap.** A fixed window keyed on the peer address plus a
  SHA-256 fingerprint of the presented bearer token when that token
  authenticates. An invalid or absent token shares the address-only bucket, so
  rotating tokens cannot mint new keys and the raw token is never held. The
  default is 120 requests per 60000 ms. Exceeding it returns 429 with
  `Retry-After` in seconds.
- **In-flight task cap.** `maxInFlight` bounds concurrent runs. The default is
  8, matching the local child runner's `MAX_CONCURRENCY`. `POST /v1/tasks` past
  the cap returns 503 with `Retry-After: 1`.

`GET /healthz` is exempt from the request cap. It is an unauthenticated
liveness probe an orchestrator calls at high frequency and it does no work, so
throttling it would produce false unhealthy verdicts without protecting
anything else.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PSTACK_WORKER_STATE_DIR` | `~/.pi/agent/pstack/hosted` | Run store root. |
| `PSTACK_WORKER_PORT` | `8787` | Listen port from `main()`. |
| `PSTACK_WORKER_TOKEN` | unset | Bearer token; unset means fail closed. |
| `PSTACK_WORKER_PI_BIN` | resolved `pi` | Override the pi binary path. |
| `PSTACK_WORKER_RATE_LIMIT_MAX` | `120` | Requests allowed per client per window on `/v1`. |
| `PSTACK_WORKER_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds. |
| `PSTACK_WORKER_MAX_IN_FLIGHT` | `8` | Concurrent runs before `POST /v1/tasks` returns 503. |

`workspaceRoot` is a `createWorkerServer` option, not an env var; it defaults
to `process.cwd()`. The full option surface is `createWorkerServer({ token,
stateDir, now, leaseMs, execute, workspaceRoot, maxInFlight, rateLimit })`,
where `rateLimit` is `{ maxRequests, windowMs }`.

## Default executor

The default executor spawns:

```
pi --mode json -p --model <model> --session-dir <stateDir>/sessions/<runId> <task>
```

with `PSTACK_CHILD_POLICY` and `PSTACK_CHILD_ROLE` in the environment. This is
the same argv shape the local child runner builds for a fresh isolated child.
The executor enforces `timeoutMs` by killing the child, and the server records
`timed_out`.
