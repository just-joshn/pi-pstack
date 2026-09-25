# R1: line-by-line fact review of the skill-text rewrite (read-only)

Diff under review: `/tmp/pkg-audit/u4-skills.diff` (`git diff -U0 48e811d c7c7a51 -- skills` in `/Users/josh-desktop/.pi/agent/pstack/pi-pstack`). Before = pre-rewrite text; after = current text. Upstream Cursor pstack 0.15.5: `/Users/josh-desktop/.pi/agent/pstack/pi-pstack/parity/upstream/0.15.5/pstack/skills/`.

Facts to check against (verify on disk, do not assume):
- Pi agent dir is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` is set. In a normal Pi session `PI_CODING_AGENT_DIR` is UNSET (measured); `PI_SESSION_FILE` is set.
- Session dir layout: `~/.pi/agent/sessions/--<cwd with / as ->--/<timestamp>_<id>.jsonl`. Task run data: `<that sessions/--cwd-- dir>/pstack-agents/<agent_id>/` (status.json, events.jsonl). Task child transcript: `<session file path without .jsonl>/<agent_id>/session.jsonl`. Look at `/Users/josh-desktop/.pi/agent/sessions/--Users-josh-desktop-.pi-agent--/` to confirm.
- Pi docs: `/Users/josh-desktop/.pi/agent/install/releases/0.87.1/node_modules/@earendil-works/pi-coding-agent/docs/` (skills.md: bundled references are relative to the skill directory).
- Model-scope config: `<agent dir>/extensions/pstack-agents.json` with top-level `modelScope`.

For every changed line pair, flag it if any of these hold:
1. A path is wrong for the real layout above (like `$PI_CODING_AGENT_DIR/pstack-agents/<agent_id>/` for run data, which is really under the session dir).
2. It writes a bare `$PI_CODING_AGENT_DIR/...` path that a model could run or write to (breaks when unset). Count them all.
3. Meaning changed beyond the path fix (a rule, number, negation, or instruction added, dropped, or altered).
4. A skill-relative reference resolves to a file that does not exist (resolve against the referring skill's directory; check on disk).
5. The after-text drifts further from the upstream 0.15.5 sentence than the before-text did, where upstream has that sentence.

Reply with only a TSV (header `file	line	rule	before_excerpt	after_excerpt	fix`) of every flagged line, then one line `reviewed N changed lines, flagged M`. Excerpts at most 120 chars. The `fix` column gives the exact replacement text for the flagged fragment.
