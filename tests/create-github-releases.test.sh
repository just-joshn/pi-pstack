#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
export MOCK_DIR="$tmp" GH_REPO=just-joshn/pi-pstack GH_TOKEN=test PATH="$tmp/bin:$PATH"
sha=0123456789012345678901234567890123456789
other=1111111111111111111111111111111111111111
notes=$(printf 'note\n%s(touch %s/injected)\nX' '$' "$tmp")
RELEASE_PLAN=$(jq -cn --arg sha "$sha" --arg notes "${notes%X}" '[{version:"0.5.0",commit:$sha,notes:$notes,latest:true}]')
export RELEASE_PLAN

cat > "$tmp/bin/git" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ ! -f $MOCK_DIR/git-fail ]] || exit 1
if [[ -f $MOCK_DIR/tag ]]; then
  printf '%s\trefs/tags/v0.5.0\n' "$(<"$MOCK_DIR/tag")"
  if [[ -f $MOCK_DIR/peeled ]]; then
    printf '%s\trefs/tags/v0.5.0^{}\n' "$(<"$MOCK_DIR/peeled")"
  fi
fi
MOCK
cat > "$tmp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ ! -f $MOCK_DIR/gh-fail ]] || exit 1
if [[ $1 == api && $2 == --paginate ]]; then
  if [[ -f $MOCK_DIR/draft ]]; then
    echo '[[{"tag_name":"v0.5.0","draft":true}]]'
  elif [[ -f $MOCK_DIR/release ]]; then
    echo '[[{"tag_name":"v0.5.0","draft":false}]]'
  else
    echo '[[]]'
  fi
elif [[ $1 == api && $2 == --method ]]; then
  [[ ! -f $MOCK_DIR/ref-fail ]] || exit 1
  [[ ! -f $MOCK_DIR/tag && $3 == POST && $4 == repos/just-joshn/pi-pstack/git/refs && $6 == ref=refs/tags/v0.5.0 ]] || exit 1
  printf '%s' "${8#sha=}" > "$MOCK_DIR/tag"
elif [[ $1 == release && $2 == create ]]; then
  [[ -f $MOCK_DIR/tag && ! -f $MOCK_DIR/release ]] || exit 1
  [[ ! -f $MOCK_DIR/create-fail ]] || exit 1
  latest=missing
  verify=no
  while (($#)); do
    if [[ $1 == --notes-file ]]; then cp "$2" "$MOCK_DIR/notes"; fi
    if [[ $1 == --latest=* ]]; then latest=$1; fi
    if [[ $1 == --verify-tag ]]; then verify=yes; fi
    shift
  done
  [[ $latest == "--latest=${MOCK_LATEST:-true}" && $verify == yes ]] || exit 1
  touch "$MOCK_DIR/release"
else
  exit 1
fi
MOCK
chmod +x "$tmp/bin/git" "$tmp/bin/gh"
run() { bash "$root/scripts/create-github-releases.sh" > /dev/null 2>&1; }
run
[[ $(<"$tmp/tag") == "$sha" && -f $tmp/release && ! -e $tmp/injected ]]
printf '%s' "${notes%X}" > "$tmp/expected"
cmp "$tmp/notes" "$tmp/expected"
run
rm "$tmp/release"
touch "$tmp/create-fail"
if run || [[ ! -f $tmp/tag || -f $tmp/release ]]; then echo 'ignored release failure' >&2; exit 1; fi
rm "$tmp/create-fail"
run
printf '%s' "$other" > "$tmp/tag"
printf '%s' "$sha" > "$tmp/peeled"
run
rm "$tmp/peeled"
if run; then echo 'accepted conflicting tag' >&2; exit 1; fi
rm "$tmp/tag"
if run; then echo 'accepted a published release without a tag' >&2; exit 1; fi
rm "$tmp/release"
touch "$tmp/draft"
if run || [[ -e $tmp/tag ]]; then echo 'accepted an existing draft' >&2; exit 1; fi
rm "$tmp/draft"
original=$RELEASE_PLAN
RELEASE_PLAN="[$(printf '%s' "$original" | jq -c '.[0]'),{}]"
if run || [[ -e $tmp/tag ]]; then echo 'accepted invalid plan' >&2; exit 1; fi
RELEASE_PLAN=$original
touch "$tmp/gh-fail"
if run || [[ -e $tmp/tag ]]; then echo 'ignored API failure' >&2; exit 1; fi
rm "$tmp/gh-fail"
touch "$tmp/git-fail"
if run || [[ -e $tmp/tag ]]; then echo 'ignored git failure' >&2; exit 1; fi
rm "$tmp/git-fail"
touch "$tmp/ref-fail"
if run || [[ -e $tmp/tag || -e $tmp/release ]]; then echo 'ignored tag creation failure' >&2; exit 1; fi
rm "$tmp/ref-fail"
if GH_REPO=other/repo run || [[ -e $tmp/tag ]]; then echo 'accepted a different repository' >&2; exit 1; fi
RELEASE_PLAN=$(jq -c '.[0].version = "0.4.1"' <<< "$original")
if run || [[ -e $tmp/tag ]]; then echo 'accepted a legacy version' >&2; exit 1; fi
RELEASE_PLAN=$(jq -c --arg sha "${sha/#0/A}" '.[0].commit = $sha' <<< "$original")
if run || [[ -e $tmp/tag ]]; then echo 'accepted a noncanonical commit SHA' >&2; exit 1; fi
RELEASE_PLAN=$(jq -c '.[0].notes = ""' <<< "$original")
if run || [[ -e $tmp/tag ]]; then echo 'accepted empty release notes' >&2; exit 1; fi
RELEASE_PLAN=$(jq -c '.[0].notes = ("é" * 4097)' <<< "$original")
if run || [[ -e $tmp/tag ]]; then echo 'accepted oversized release notes' >&2; exit 1; fi
RELEASE_PLAN=$(jq -c '.[0].latest = false' <<< "$original")
MOCK_LATEST=false run
[[ $(<"$tmp/tag") == "$sha" && -f $tmp/release ]]
echo 'Release writer mock tests passed'
