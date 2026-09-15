# Port parity

The ported tree is a pure function of upstream pstack plus the bindings declared here.

```
local file == apply(bindings, upstream file)
```

for every file upstream ships under `skills/`, `agents/`, `automations/`, and `docs/`. Anything not produced by a binding is drift. The upstream commit is pinned in `upstream.json`.

## Commands

```bash
npm run parity:check   # exit 1 on drift, a missing file, an unmigrated Cursor token, a missing override section, an unknown pstack_* tool, or a dead script path
npm run parity:sync    # regenerate the ported tree from upstream + bindings (overrides are skipped)
node port/port.mjs diff --file skills/arena/SKILL.md
```

`check` fetches upstream into `.port-upstream/` on first run (or sees `PORT_UPSTREAM_DIR` / `--upstream <dir>`).

`sync` rewrites every ported file. Uncommitted hand edits to ported files are lost by design: all legitimate divergence lives in `bindings.mjs`.

## Bindings

`bindings.mjs` holds:

- **`bindings`**: ordered Cursor-to-Pi substitutions. Each rule has an `id`, a `why` naming the Cursor mechanism it replaces, an optional `files` glob, and a `find`/`replace` pair. Longest, most specific rules run first.
- **`overrides`**: files whose whole mechanism is Cursor-only, so a Pi twin is hand-written. Each override pins upstream sections it must keep verbatim, and the general leftover scan must stay clean. Two files qualify today: `make-bot-ui` (Grok Bot routines) and `setup-pstack` (the always-applied `.mdc` rule).
- **`leftoverTokens`**: Cursor mechanisms that must not survive into a ported file. A hit is a bug in the port, not a warning.

A new binding must replace a Cursor mechanism, stay minimal, and not add Pi commentary. Pi-only guidance belongs in the extensions or the package README, not in upstream prose.

## Bumping upstream

1. Update `commit` (and `version`) in `upstream.json`.
2. `npm run parity:check` and read the drift report.
3. For each drift: add a binding if a Cursor mechanism changed, or `npm run parity:sync` to absorb upstream edits verbatim.
4. Fix `leftoverTokens` hits with bindings, never by editing the ported file.
5. Re-read the override files against upstream if they changed.
