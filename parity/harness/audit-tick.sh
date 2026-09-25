#!/usr/bin/env bash
# One audit tick over a coordinator session: every live Task and Shell run in its workspace session tree, every
# worktree of this repo (new commits verified on a clean snapshot), forbidden commands in child transcripts,
# the live agent-dir config, and this repo's remote. Prints facts only. Run from the coordinator session.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TREE="$(dirname "${PI_SESSION_FILE:?run inside a Pi session}")"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
STATE="$AGENT/pstack/audit-state/tick"; mkdir -p "$STATE"
[ -f "$STATE/epoch" ] || touch "$STATE/epoch" "$STATE/mark"
now=$(date +%s)
echo "tick $(date -u +%H:%M:%SZ)"

find "$TREE" -path '*/pstack-agents/*' -name status.json -newer "$STATE/epoch" 2>/dev/null | while read -r file; do
  state=$(jq -r .state "$file"); case "$state" in running|starting) ;; *) continue ;; esac
  dir=$(dirname "$file"); id=$(basename "$dir")
  what=$(jq -r '.request.agent.name // .request.kind // "?"' "$dir/request.json" 2>/dev/null)
  seen=$(/usr/bin/stat -f %m "$dir/events.jsonl" 2>/dev/null || /usr/bin/stat -f %m "$file")
  idle=$((now - seen))
  # A shell is quiet between outputs by design; only an agent run that stops writing events is a stall.
  echo "run ${id:0:8} $what $state idle=${idle}s$([ "$what" != shell ] && [ "$idle" -gt 900 ] && echo ' STALL?')"
done

git -C "$REPO" worktree list --porcelain | awk '/^worktree /{print $2}' | while read -r tree; do
  name=$(basename "$tree"); head=$(git -C "$tree" rev-parse HEAD)
  last=$(cat "$STATE/head-$name" 2>/dev/null || echo "$head")
  echo "tree $name ${head:0:7} dirty=$(git -C "$tree" status --porcelain | wc -l | tr -d ' ')"
  git -C "$tree" log --format='  commit %h %s' "$last..$head"
  if [ "$last" != "$head" ]; then
    snap=$(mktemp -d); git -C "$tree" archive "$head" | tar -x -C "$snap"; ln -s "$REPO/node_modules" "$snap/node_modules"
    if (cd "$snap" && npm run -s typecheck && npm test && npm run -s parity && npm run -s lint:package) >"$STATE/verify-$name.log" 2>&1 &&
      (cd "$tree" && node parity/provenance.mjs) >>"$STATE/verify-$name.log" 2>&1; then
      echo "  verify ${head:0:7}: PASS"
    else
      echo "  verify ${head:0:7}: FAIL (log $STATE/verify-$name.log)"
    fi
    rm -rf "$snap"
  fi
  echo "$head" > "$STATE/head-$name"
done

find "$TREE" -mindepth 2 -name '*.jsonl' -newer "$STATE/mark" -exec grep -hoE \
  '"command": ?"[^"]{0,100}(push[^"]{0,30}--force|gh repo delete|pkill|killall|rm -rf [^"]{0,20}\.pi/agent/(pstack/pi-pstack|pstack/backups|skills|extensions|agents)|gh pr (create|merge)[^"]{0,60}pi-pstack)[^"]{0,60}' {} + 2>/dev/null |
  sort -u | head -5 | sed 's/^/FORBIDDEN?: /'
touch "$STATE/mark"

live=$(cd "$AGENT" && find AGENTS.md settings.json extensions agents skills -type f 2>/dev/null | sort | xargs shasum | shasum | cut -c1-12)
[ -f "$STATE/live" ] || echo "$live" > "$STATE/live"
echo "live config: $([ "$live" = "$(cat "$STATE/live")" ] && echo unchanged || echo "CHANGED ($live)")"
main=$(git -C "$REPO" ls-remote origin refs/heads/main | cut -c1-7)
branch=$(git -C "$REPO" branch --show-current); remote=$(git -C "$REPO" ls-remote origin "refs/heads/$branch" | cut -c1-40)
echo "origin/main $main; origin/$branch ${remote:0:7} $(git -C "$REPO" merge-base --is-ancestor "$remote" HEAD 2>/dev/null && echo '(ancestor of local)' || echo DIVERGED)"
