---
name: make-bot-ui
description: >-
  Use when building a custom UI (page, dashboard, buttons) or Pi TUI surface that
  should wake an agent over a webhook or local trigger, when the user must provide
  a webhook sender key, or when exposing that UI on Tailscale.
disable-model-invocation: true
---

# Make bot UI (Pi twin)

> **Pi port.** Upstream Cursor skill targets Grok Bot webhook routines + `update_state` / `SendToUser` secret cards. On Pi, build the closest twin: a local server that POSTs to a user-provided webhook (or writes a wake file), keep secrets out of the model context, and optionally add a Pi TUI panel via an extension using `ctx.ui.custom` / `ctx.ui.notify`.

Build a page the user clicks. A server on this computer POSTs JSON to a webhook. The agent wakes with that JSON (via the user's automation host, CI, or a `pstack_loop` watcher). Keep the sender key on the server. Do not put the sender key in the browser, in chat, or in this skill.

## Create the wake target

1. Ask the user for the webhook URL they already own (Slack workflow, GitHub repo_dispatch, personal automation host, etc.). Pi has no Cursor `update_state` routine API.
2. If they have no webhook yet, offer the **local wake file** twin: buttons append JSON lines to `~/.pi/agent/pstack-wakes.jsonl`; a `pstack_loop` watcher (`mode=watcher`, `watchCommand` that `tail -n0 -F` or polls the file) injects the payload into the session.

## Request the sender key safely

Do not accept the sender key in chat. Prefer:

- User stores `{url, key}` in a file outside the repo (e.g. `~/.config/pstack-bot-ui/<slug>.json`) with mode `0600`
- Or an env var the local server reads (`PSTACK_WEBHOOK_URL`, `PSTACK_WEBHOOK_KEY`)

Never print or log the key. Never commit it.

## Host the page on this computer

Store `{url, key}` in that UI's own directory (gitignored). Buttons POST to this local server. The local server, not the browser, POSTs to the webhook.

Bind the server to `0.0.0.0:<port>`, not `127.0.0.1`, if Tailscale peers must reach it.

The server POSTs with:

- method `POST`
- `Content-Type: application/json`
- `Authorization: Bearer <key>` (and optionally `X-Automation-Key: <key>`)
- body: one JSON object with the fields named in the wake prompt
- timeout: 8 seconds
- one try, no retry

Before telling the user the UI is live, probe once with a harmless payload.

If a POST can fail, append the same JSON to a local log and drain it from the wake path. Do not poll as the primary path. Do not send media bytes on the webhook.

## Pi TUI companion (optional)

When the user wants the control surface inside Pi rather than a browser page, add a small extension that:

- `pi.registerCommand` for each button action
- `ctx.ui.custom` / `ctx.ui.notify` / `ctx.ui.select` for the panel
- On click, POST via the local server helper (same secret rules)

Do not invent Cursor IDE chrome. Prefer official `@earendil-works/pi-tui` components.

## Put the page on the tailnet

If `tailscale status` shows an online node, skip install. Read hostname from `tailscale status` and IPv4 from `tailscale ip -4`. Give the user both URLs. Do not create a second hostname on a node that is already online.

## Verify

1. Click each button once.
2. Confirm the wake arrived (agent turn, wake-file line, or webhook receiver log).
3. Confirm the key never appeared in chat, logs, or the repo.
