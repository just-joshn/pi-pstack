#!/usr/bin/env bash
# Local CI for a scratch GitHub repo without Actions: at each open PR head, run install, tests, and typecheck once,
# then post a commit status. Usage: local-ci.sh <owner/repo> [context]. Runs until stopped.
set -uo pipefail
REPO="${1:?usage: local-ci.sh <owner/repo> [context]}"
CONTEXT="${2:-local-ci/test}"
STATE="$HOME/.pi/agent/pstack/audit-state/local-ci/${REPO//\//_}"
WORK="${TMPDIR:-/tmp}/pstack-local-ci"
mkdir -p "$STATE/done" "$STATE/logs" "$WORK"

status() { gh api "repos/$REPO/statuses/$1" -f state="$2" -f context="$CONTEXT" -f description="$3" >/dev/null 2>&1; }

while true; do
  gh pr list -R "$REPO" --state open --json number,headRefOid -q '.[]|"\(.number) \(.headRefOid)"' 2>/dev/null |
    while read -r number sha; do
      [ -e "$STATE/done/$sha" ] && continue
      status "$sha" pending "bun test and tsc running"
      tree="$WORK/$sha"; log="$STATE/logs/$sha.log"; rm -rf "$tree"
      if gh repo clone "$REPO" "$tree" -- -q >"$log" 2>&1 &&
        git -C "$tree" fetch -q origin "pull/$number/head" >>"$log" 2>&1 &&
        git -C "$tree" checkout -q "$sha" >>"$log" 2>&1 &&
        (cd "$tree" && bun install --frozen-lockfile && bun test && bunx tsc --noEmit -p .) >>"$log" 2>&1; then
        result=success
      else
        result=failure
      fi
      status "$sha" "$result" "bun test and tsc: $result"
      echo "$(date -u +%H:%M:%SZ) PR #$number ${sha:0:7} $result"
      touch "$STATE/done/$sha"; rm -rf "$tree"
    done
  sleep 30
done
