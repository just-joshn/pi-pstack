# Port parity

The ported tree is a pure function of upstream pstack plus the bindings declared in `port/bindings/`.

```
local file == apply(bindings, upstream file)
```

for every file upstream ships under `skills/`, `agents/`, `automations/`, and `docs/`. Anything not produced by a binding is drift. The upstream commit is pinned in `../upstream.lock.json` (the normative record: repository, path, full SHA, plugin version, capture date, pstack/ tree digest) and mirrored into `upstream.json` (the field `port.mjs` reads directly). The two files must always name the same commit; `node port/drift.mjs report` fails loudly if they diverge.

## Commands

```bash
npm run parity:check   # exit 1 on drift, a missing file, an unmigrated Cursor token, a missing override section, an unknown pstack_* tool, or a dead script path
npm run parity:sync    # regenerate the ported tree from upstream + bindings (overrides are skipped)
node port/port.mjs diff --file skills/arena/SKILL.md
node port/port.mjs rules   # list bindings and whether each fired
node port/drift.mjs report # commits/files that changed under pstack/ since the pin, on origin/main
```

`drift.mjs report` never advances the pin and never fails on drift itself (only on a
lock/pin mismatch or on the two pin files disagreeing). It is how you find out the pin
is stale before deciding to bump it; treat every commit it lists as unreviewed until
someone reclassifies the affected inventory rows and updates both pin files together.

`check` fetches upstream into `.port-upstream/` on first run (or sees `PORT_UPSTREAM_DIR` / `--upstream <dir>`).

`sync` rewrites every ported file. Uncommitted hand edits to ported files are lost by design: all legitimate divergence lives in `port/bindings/`.

Bytes are compared first. A text file (`.md`, `.sh`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.json`, `.yaml`, `.yml`, `.tsv`, `.txt`) is compared byte-for-byte, then decoded and re-encoded, so a string-equal file with different bytes reports `BYTE DRIFT`. Anything outside that extension list is binary: differing bytes report `BINARY DRIFT`, and `sync` prints `REFUSING to sync binary <path>` and exits 1. Local-only files under a scoped directory must be declared in `port/bindings/` `extras`; otherwise `check` prints an `undeclared local-only` line and fails.

## Bindings

`port/bindings/` holds:

- **`bindings`**: ordered Cursor-to-Pi substitutions. Each rule has an `id`, a `why` naming the Cursor mechanism it replaces, an optional `files` glob, and a `find`/`replace` pair. Longest, most specific rules run first.
- **`overrides`**: files whose whole mechanism is Cursor-only, so a Pi twin is hand-written. Each override's `must` list pins the named upstream sections that stay verbatim, and the leftover scan rejects Cursor mechanisms in the whole file. Overrides are hand-maintained and reviewed. Two files qualify today: `make-bot-ui` (Grok Bot routines) and `setup-pstack` (the always-applied `.mdc` rule).
- **`leftoverTokens`**: Cursor mechanisms that must not survive into a ported file. A hit is a bug in the port, not a warning.

A new binding must replace a Cursor mechanism, stay minimal, and not add Pi commentary. Pi-only guidance belongs in the extensions or the package README, not in upstream prose.

## Bumping upstream

1. Run `node port/drift.mjs report` and read every commit/file it lists under pstack/.
2. Update `commit` (and `pluginVersion`) in `../upstream.lock.json`, then mirror the same `commit` (and `version`) into `upstream.json`.
3. `npm run parity:check` and read the drift report.
4. For each drift: add a binding if a Cursor mechanism changed, or `npm run parity:sync` to absorb upstream edits verbatim.
5. Fix `leftoverTokens` hits with bindings, never by editing the ported file.
6. Re-read the override files against upstream if they changed.
7. Reclassify any inventory rows in `spec/contracts/*.tsv` that the drift affected; a pin bump is not complete until the ledger reflects the new upstream state.

The behavioral contract lives in `spec/SPEC.md`; this file owns content parity.
