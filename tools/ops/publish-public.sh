#!/usr/bin/env bash
# Regenerate the `public` branch: a snapshot of a source branch (default: develop)
# without the private paths, then print the push command. The public GitHub repo
# (`origin`) serves `public` as its `main`; the full history lives in the private
# remote. The working tree and the real index are never touched.
#
# Usage: tools/ops/publish-public.sh [source-branch] [--fresh]
#   --fresh  start the public history over with a single orphan commit (needs a
#            force push). Without it the snapshot is chained onto the existing
#            `public` branch as one new commit.
set -euo pipefail

SRC=develop
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) SRC=$arg ;;
  esac
done

# Paths that never reach the public repo. IGNORE_BLOCK is appended to the
# snapshot's .gitignore so a public clone keeps ignoring them; keep both in sync.
PRIVATE_PATHS=(.claude _bmad _bmad-output CLAUDE.local.md)
IGNORE_BLOCK='
# Public snapshot (tools/ops/publish-public.sh): these live in the private remote
.claude/
_bmad/
_bmad-output/
CLAUDE.local.md
'

cd "$(git rev-parse --show-toplevel)"
git rev-parse --verify --quiet "refs/heads/$SRC" >/dev/null || { echo "no branch $SRC" >&2; exit 1; }

# Build the snapshot in a temporary index.
TMP_INDEX=$(mktemp)
trap 'rm -f "$TMP_INDEX"' EXIT
export GIT_INDEX_FILE=$TMP_INDEX
git read-tree "$SRC"
git rm -r -q --cached --ignore-unmatch "${PRIVATE_PATHS[@]}"
gitignore_blob=$({ git show "$SRC:.gitignore"; printf '%s' "$IGNORE_BLOCK"; } | git hash-object -w --stdin)
git update-index --add --cacheinfo "100644,$gitignore_blob,.gitignore"
tree=$(git write-tree)
unset GIT_INDEX_FILE

# Refuse to publish if a private path survived.
leak=$(git ls-tree -r --name-only "$tree" | grep -E '^(\.claude|_bmad|_bmad-output)/|^CLAUDE\.local\.md$' || true)
if [ -n "$leak" ]; then
  echo "private paths in snapshot:" >&2
  echo "$leak" >&2
  exit 1
fi

msg="Horos public snapshot ($SRC@$(git rev-parse --short "$SRC"))"
if [ "$FRESH" = 1 ] || ! git rev-parse --verify --quiet refs/heads/public >/dev/null; then
  commit=$(git commit-tree "$tree" -m "$msg")
  push="git push --force-with-lease origin public:main"
else
  if [ "$(git rev-parse 'public^{tree}')" = "$tree" ]; then
    echo "public already matches $SRC"
    exit 0
  fi
  commit=$(git commit-tree "$tree" -p refs/heads/public -m "$msg")
  push="git push origin public:main"
fi
git update-ref refs/heads/public "$commit"

echo "public -> $commit"
echo "review: git show --stat public"
echo "push:   $push"
