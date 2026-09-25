#!/usr/bin/env bash
# Switch a loose-file pstack install in Pi's agent directory to this package. Moves, never deletes.
# Usage: live-switch.sh [--apply]   (default is a dry run that prints every action)
# Writes <backup>/rollback.sh, which restores the pre-switch state exactly.
set -euo pipefail
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PKG="$(cd "$(dirname "$0")/../.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$AGENT/pstack/backups/pre-package-$STAMP"
SKILLS=$(cd "$PKG/skills" && ls)
EXTENSIONS="pstack-agents pstack-guards.ts pstack-mode.ts questionnaire.ts todo.ts"
AGENTS=$(cd "$PKG/agents" && ls)

run() { echo "+ $*"; if [ $APPLY = 1 ]; then "$@"; fi; }

echo "agent dir: $AGENT"; echo "package:   $PKG"; echo "backup:    $BACKUP"
run mkdir -p "$BACKUP/skills" "$BACKUP/extensions" "$BACKUP/agents"
run cp -p "$AGENT/AGENTS.md" "$AGENT/settings.json" "$BACKUP/"
[ -f "$AGENT/extensions/pstack-agents.json" ] && run cp -p "$AGENT/extensions/pstack-agents.json" "$BACKUP/"
for s in $SKILLS; do [ -e "$AGENT/skills/$s" ] && run mv "$AGENT/skills/$s" "$BACKUP/skills/$s"; done
for e in $EXTENSIONS; do [ -e "$AGENT/extensions/$e" ] && run mv "$AGENT/extensions/$e" "$BACKUP/extensions/$e"; done
for a in $AGENTS; do [ -e "$AGENT/agents/$a" ] && run mv "$AGENT/agents/$a" "$BACKUP/agents/$a"; done

# Model scope moves from settings.json subagents.modelScope to extensions/pstack-agents.json.
SCOPE=$(jq -c '.subagents.modelScope // empty' "$AGENT/settings.json")
if [ -n "$SCOPE" ]; then
  echo "+ write $AGENT/extensions/pstack-agents.json with modelScope $SCOPE; drop settings.json .subagents"
  if [ $APPLY = 1 ]; then
    jq -n --argjson s "$SCOPE" '{modelScope: $s}' > "$AGENT/extensions/pstack-agents.json"
    jq 'del(.subagents)' "$AGENT/settings.json" > "$AGENT/settings.json.tmp" && mv "$AGENT/settings.json.tmp" "$AGENT/settings.json"
  fi
fi

# The pstack block's reminder names poteto-mode's SKILL.md; point it at the package copy.
echo "+ AGENTS.md: ~/.pi/agent/skills/poteto-mode/SKILL.md -> $PKG/skills/poteto-mode/SKILL.md"
if [ $APPLY = 1 ]; then
  python3 - "$AGENT/AGENTS.md" "$PKG/skills/poteto-mode/SKILL.md" <<'PY'
import sys
path, target = sys.argv[1], sys.argv[2]
text = open(path).read()
for old in ("~/.pi/agent/skills/poteto-mode/SKILL.md", sys.argv[1].rsplit("/AGENTS.md", 1)[0] + "/skills/poteto-mode/SKILL.md"):
    text = text.replace(f"`{old}`", f"`{target}`")
open(path, "w").write(text)
PY
fi

run pi install "$PKG"

[ $APPLY = 1 ] || { echo "dry run only; rerun with --apply (writes $BACKUP/rollback.sh)"; exit 0; }
cat > "$BACKUP/rollback.sh" <<EOF
#!/usr/bin/env bash
# Restore the loose-file install that existed before $STAMP.
set -euo pipefail
pi remove "$PKG" || true
for d in skills extensions agents; do for f in "$BACKUP/\$d"/*; do [ -e "\$f" ] && mv "\$f" "$AGENT/\$d/"; done; done
cp -p "$BACKUP/AGENTS.md" "$BACKUP/settings.json" "$AGENT/"
if [ -f "$BACKUP/pstack-agents.json" ]; then cp -p "$BACKUP/pstack-agents.json" "$AGENT/extensions/"; else rm -f "$AGENT/extensions/pstack-agents.json"; fi
echo "restored; restart Pi"
EOF
chmod +x "$BACKUP/rollback.sh"; echo "rollback: $BACKUP/rollback.sh"
