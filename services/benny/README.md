# benny event service

The hosted execution path for the benny surface. An authenticated receiver turns
Slack-shaped issue reports and generic webhook events into durable wake records,
then appends the same wake line `extensions/benny` writes. A local agent drains
that line with `pstack_benny_wake` and runs `/benny-triage` or `/benny-repro`.

Without this service the local twin is `pstack_benny_wake` plus a `pstack_loop`
watcher on the wake file. That path has no HTTP receiver, no Slack signature
check, and no durable pending queue. The pair `ceiling-03` and `ceiling-04` in
`spec/contracts/companions.tsv` name this service as the hosted execution path
for the Automations Slack bus and Grok Bot routines.

## Run it

```
PSTACK_BENNY_TOKEN=$(openssl rand -hex 24) node services/benny/server.mjs
```

The server listens on `PSTACK_BENNY_PORT` (default 8788) and prints the port to
stdout. `GET /healthz` is open. Every other route is authenticated.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PSTACK_BENNY_TOKEN` | unset | Bearer token. Required for reads, acknowledgements, and inbound events when no signing secret is set. |
| `PSTACK_BENNY_SIGNING_SECRET` | unset | Slack app signing secret. Verifies inbound Slack events by v0 HMAC. |
| `PSTACK_BENNY_PORT` | `8788` | Listen port. |
| `PSTACK_BENNY_STATE_DIR` | `~/.pi/agent/pstack/benny-events` | Event store root. |
| `PSTACK_BENNY_WAKE_FILE` | `~/.pi/agent/pstack-benny-wakes.jsonl` | Wake file the agent drains. |
| `PSTACK_BENNY_CONFIG_DIR` | `~/.pi/agent` | Directory holding `benny.json`. |

`~/.pi/agent/benny.json` holds the routes.

```json
{
  "routes": [{ "channel": "C_SOURCE", "intent": "triage" }],
  "defaultIntent": "triage"
}
```

Intent is one of `triage`, `repro`, `ignore`. A route matches on the source
channel. An unmatched channel falls to `defaultIntent`. The writer owns only the
`routes` and `defaultIntent` keys, so a local edit under any other key survives
an update. See `writeConfig` in `services/benny/routing.mjs`. A config file that
is not valid JSON, or that names an unknown intent or a channel that is not a
string, stops startup with the file path in the error.

## Auth

A route with neither credential configured returns 503 and runs nothing. That is
the fail-closed rule, not a degraded mode.

- `POST /v1/benny/events` and `POST /v1/benny/test-event` accept a valid Slack v0
  signature when `PSTACK_BENNY_SIGNING_SECRET` is set, or a valid bearer token.
- `POST /v1/hooks/:source` takes the same two credentials.
- `GET /v1/benny/events` and `POST /v1/benny/events/:id/ack` require the bearer
  token.

A Slack signature covers the exact bytes of the body, so the server verifies it
before parsing. `X-Slack-Request-Timestamp` must be inside a 300 second window.

Neither credential is stored, echoed in a response, or written to a log. A stored
record keeps a SHA-256 key derived from source and source event id instead of the
raw id. `services/benny/routing.mjs` derives the key and the event id from it, so
a redelivery of the same source event resolves to the same record.

## Endpoints

| Method | Path | Success | Meaning |
| --- | --- | --- | --- |
| POST | `/v1/benny/events` | 202 `{eventId, state:"pending", intent}` | Accept a Slack event and enqueue a wake. |
| POST | `/v1/benny/events` (repeat source event) | 200 `{eventId, state, intent}` | Existing record, no second wake line, a retry if the first wake append failed. |
| POST | `/v1/benny/events` (Slack `url_verification`) | 200 `{challenge}` | Answer the Slack app URL handshake without persisting anything. |
| POST | `/v1/hooks/:source` | 202 ack | Accept a generic webhook body. |
| POST | `/v1/benny/test-event` | 200 `{enqueued:false, record}` | Normalize and return without persisting. |
| GET | `/v1/benny/events?state=pending` | 200 `{state, count, events}` | List events, optionally filtered. |
| POST | `/v1/benny/events/:id/ack` | 200 ack | Mark an event processed. |
| GET | `/healthz` | 200 `{status:"ok"}` | Liveness. Never requires auth. |

Failures are 400 for malformed JSON or a bad shape, 401 for a bad credential, 404
for an unknown event, 413 for a body over 256 KiB, and 503 when no credential is
configured. A body that fails parsing or shape checking is never persisted.

## Send a test event

```
curl -sS -X POST http://127.0.0.1:8788/v1/benny/test-event \
  -H "authorization: Bearer $PSTACK_BENNY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"type":"event_callback","event_id":"Ev-test-1","event":{"channel":"C_SOURCE","ts":"1700000000.000100","text":"checkout crashes","user":"U1"}}'
```

That returns the normalized record and persists nothing. Drop `/test-event` to
enqueue a real event, then read it back.

```
curl -sS 'http://127.0.0.1:8788/v1/benny/events?state=pending' \
  -H "authorization: Bearer $PSTACK_BENNY_TOKEN"
curl -sS -X POST "http://127.0.0.1:8788/v1/benny/events/<eventId>/ack" \
  -H "authorization: Bearer $PSTACK_BENNY_TOKEN"
```

A generic webhook sender, including the local server in `skills/make-bot-ui`,
posts to `/v1/hooks/<source>` with an optional `eventId` for idempotency.

```
curl -sS -X POST http://127.0.0.1:8788/v1/hooks/make-bot-ui \
  -H "authorization: Bearer $PSTACK_BENNY_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"eventId":"ui-1","payload":{"channel":"C_SOURCE","ts":"1700000001.000200","text":"button pressed"}}'
```

## Contract map

| Mandate item | Implementation | Test |
| --- | --- | --- |
| Source-thread association | `normalizeSlackEvent` sets `threadTs` from `thread_ts` with a fallback to `ts`, and `wakeLineFor` carries channel and thread into the payload. | `benny-events-01 slack report persists pending with one wake line` |
| Webhook and event wake | `routeRequest` and `enqueue` persist the record, then `deliverEvent` appends one `{ts, intent, payload}` line. | `benny-events-01`, `benny-events-06 generic hook normalizes and enqueues` |
| Durable configuration | `loadConfig` reads `~/.pi/agent/benny.json` and `resolveIntent` routes the channel. | `benny-events-03 config write preserves unknown user keys` |
| Safe setup and update preserving user edits | `writeConfig` merges only `routes` and `defaultIntent` and rewrites atomically. | `benny-events-03` |
| Secret handling | `verifySlackSignature` and `authorizeInbound` hold both credentials, `sourceEventKeyOf` stores a derived key, and no path echoes a credential. | `benny-events-07 stored records and responses carry no secret`, `benny-failure-01`, `benny-failure-02` |
| Test-event verification | The `/v1/benny/test-event` route normalizes under the same auth and persists nothing. | `benny-events-05 test event returns the normalized record without enqueuing` |
| Slack app install handshake | `urlVerificationChallenge` answers `url_verification` with the challenge before any record is written. | `benny-events-08 slack url verification echoes the challenge` |
| Fail-closed auth | `routeRequest` returns 503 before routing when neither credential is configured. | `benny-failure-03 no configured credential fails closed with 503` |
| Durable pending queue | `createEventStore` writes one atomic JSON file per event, and a failed wake append leaves the record pending. | `benny-failure-05 a failed wake append keeps the event pending and retries`, `benny-events-04 pending event survives a restart` |

## Storage

```
~/.pi/agent/pstack/benny-events/events/<eventId>.json
~/.pi/agent/pstack-benny-wakes.jsonl
```

Each event file is written to a temp file in the same directory and renamed, so a
crash never replaces a good record with a half-written one. The record lands on
disk before the wake line is appended. If the append fails, the record stays
`pending` with `wakeAppendedAt: null` and `lastWakeError` set, and the next
delivery of the same source event retries the append. A record is `processed`
only after `/ack`.

`GET /v1/benny/events?state=pending` is the queue that a local agent or cron can
replay. `services/benny/store.mjs` is the store, and
`tests/hosted/benny-helpers.mjs` is the shared test harness.
