# Hosted capabilities

Some pstack capabilities cannot run inside the local Pi process. They need a
service that holds a credential, speaks a protocol Pi does not implement, or
keeps state past the agent session. This file states which capabilities those
are, what each service needs, how to start and verify it, and what the local
tree does instead.

`compat/REPORT.md` section 7 is the generated list of the same prerequisites.
This file is the human-readable companion.

## What is hosted and what is not

Hosted infrastructure is required for these capability groups.

- Hosted task execution. `pstack_task` with `environment=hosted` hands the
  envelope to `services/worker` instead of spawning a local child.
- Durability and remote isolation. `services/worker` owns the durable run
  record, restart reconciliation, and the cloud/container isolation that the
  `cloud-agents` and `durable-jobs` ceilings name.
- MCP reach and IDE driving. A provisioned worker host is the path for the
  `mcp` ceiling and the `ide-driving` ceiling.
- Slack and webhook intake. `services/benny` receives Slack issue-report events
  and the generic `make-bot-ui` webhook.

Everything else runs locally. The ledger rows classified `EXACT-CONTRACT` and
`ADAPTED-EQUIVALENT` have a Pi mechanism in this repository. The two remaining
`APPROVED-EXCEPTION` ceilings (`marketplace` and `sticky-host`) need Cursor host
chrome, not a hosted service.

A hosted-classified feature used only through its local twin is **not** parity
with a requested hosted run. A local child has no durable record, no restart
reconciliation, and no remote isolation. A local-only result must never be
reported as a hosted run.

## services/worker

The worker is the hosted execution path for `pstack_task`
(`environment=hosted`), the durability the `durable-jobs` ceiling names, and the
host required by the `mcp` and `ide-driving` ceilings. It accepts a validated
task envelope, runs the child, and keeps the run record on disk so a restart
does not lose the result. `services/worker/PROTOCOL.md` is the protocol of
record.

Start it.

```bash
PSTACK_WORKER_TOKEN=$(openssl rand -hex 24) node services/worker/server.mjs
```

The server listens on `PSTACK_WORKER_PORT` (default 8787). `GET /healthz` is
open. Every `/v1` route requires `Authorization: Bearer $PSTACK_WORKER_TOKEN`,
and with no token configured those routes fail closed with 503.

Point pstack at it with `PSTACK_HOSTED_URL`. The client in
`extensions/hosted/client.ts` refuses to fall back to a local child, because a
hosted run has different durability semantics.

Verify it.

```bash
npm run test:hosted                       # tests/hosted/*.test.mjs
curl -sS http://127.0.0.1:8787/healthz    # {"status":"ok"}
```

Local twin. The local tree falls back to its own mechanisms rather than the
worker, and each fallback is weaker on purpose.

- `cloud-agents` -> isolated local git worktrees (`pstack_worktree`).
- `durable-jobs` -> session-scoped `pstack_jobs` that end with the session.
- `mcp` -> child tool grants compiled in `extensions/agents/policy.ts`.
- `ide-driving` -> `pstack_control_cli` and `pstack_control_ui`.

## services/benny

The benny service is the hosted intake path for Slack issue-report events and
the generic `make-bot-ui` webhook. It normalizes an event, stores it durably,
and appends one wake line to the wake file that `extensions/benny` reads.
`services/benny/README.md` is the protocol of record.

Start it.

```bash
PSTACK_BENNY_TOKEN=$(openssl rand -hex 24) node services/benny/server.mjs
```

The server listens on `PSTACK_BENNY_PORT` (default 8788). `GET /healthz` is
open. Inbound Slack events verify a v0 HMAC when `PSTACK_BENNY_SIGNING_SECRET`
is set; other routes require the bearer token. With neither credential
configured, every route fails closed with 503.

Verify it.

```bash
npm run test:hosted                       # tests/hosted/benny-*.test.mjs
curl -sS http://127.0.0.1:8788/healthz    # {"status":"ok"}
curl -sS -X POST http://127.0.0.1:8788/v1/benny/test-event \
  -H "authorization: Bearer $PSTACK_BENNY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"type":"event_callback","event_id":"Ev-test-1","event":{"channel":"C_SOURCE","ts":"1700000000.000100","text":"checkout crashes","user":"U1"}}'
```

Local twin. `pstack_benny_wake` appends a wake payload and a `pstack_loop`
watcher drains it. That path has no HTTP receiver, no Slack signature check,
and no durable pending queue. `docs/guide` and `automations/benny` describe the
local flow.

## Integration capability directory

`PSTACK_INTEGRATIONS_DIR` overrides the directory that holds the authored
command-adapter entries read by `extensions/integrations/registry.ts`. It
defaults to `~/.pi/agent/pstack`. An adapter entry makes a semantic integration
category available; when no adapter is present, `pstack_integrations` returns a
coverage gap that names the missing prerequisite instead of skipping silently.
The `mcp` ceiling is the hosted case of this surface.

## Environment variables

| Variable | Service | Default | Purpose |
| --- | --- | --- | --- |
| `PSTACK_HOSTED_URL` | worker client | unset | Base URL of `services/worker`; unset is a hard error for a hosted run. |
| `PSTACK_WORKER_TOKEN` | worker | unset | Bearer token; unset fails closed with 503. |
| `PSTACK_WORKER_PORT` | worker | `8787` | Listen port. |
| `PSTACK_WORKER_STATE_DIR` | worker | `~/.pi/agent/pstack/hosted` | Durable run store root. |
| `PSTACK_BENNY_TOKEN` | benny | unset | Bearer token for reads, acknowledgements, and inbound events. |
| `PSTACK_BENNY_SIGNING_SECRET` | benny | unset | Slack app signing secret; verifies inbound events by v0 HMAC. |
| `PSTACK_BENNY_PORT` | benny | `8788` | Listen port. |
| `PSTACK_BENNY_STATE_DIR` | benny | `~/.pi/agent/pstack/benny-events` | Event store root. |
| `PSTACK_BENNY_WAKE_FILE` | benny | `~/.pi/agent/pstack-benny-wakes.jsonl` | Wake file the agent drains. |
| `PSTACK_BENNY_CONFIG_DIR` | benny | `~/.pi/agent` | Directory holding `benny.json`. |
| `PSTACK_INTEGRATIONS_DIR` | integrations | `~/.pi/agent/pstack` | Directory holding command-adapter entries. |

The worker state dir, the benny state dir, and the wake file are Pi-native paths
under the agent directory. No Cursor state path is an interface.
