#!/usr/bin/env bash
# Update the pipeline on plex, where the crons run it (D-042, D-058, D-059).
#
# This is NOT the docroot deploy. `scripts/deploy.sh` mirrors `dist/` into the
# served directory; the pipeline must never go there (D-018, D-053) and does not.
#
# The server holds a git checkout, so the normal path is `git pull --ff-only`
# into it — which is what this does by default. That makes "which code is
# production running?" answerable rather than asserted: `git -C <repo> rev-parse
# HEAD` is the answer, and it can be compared against what was reviewed. There
# is nothing to build; the pipeline is standard-library Python (D-043).
#
#     scripts/deploy-pipeline.sh                    # pull the committed tree
#     PIPELINE_RSYNC=1 scripts/deploy-pipeline.sh   # push the *working* tree
#
# The rsync form exists for the loop before a commit: agents never commit
# (AGENTS.md rule 7), so a pipeline change cannot reach the server through git
# until the human gate closes. It leaves the checkout dirty on purpose — that
# dirt is the signal that production is running something unreviewed, and
# `git -C <repo> checkout -- pipeline` puts it back.
set -euo pipefail

HOST="${PIPELINE_HOST:-plex}"
REPO="${PIPELINE_REPO:-/home/pmeenan/src/meenan.dev/cve}"
cd "$(dirname "$0")/.."

if [[ "${PIPELINE_RSYNC:-0}" != "1" ]]; then
  ssh "$HOST" "git -C '$REPO' pull --ff-only"
  echo "production is now running $(ssh "$HOST" "git -C '$REPO' rev-parse HEAD")"
  exit 0
fi

# `rsync --delete` mirrors deletions, so a wrong destination does not fail — it
# empties something and fills it with Python. The docroot and the published data
# plane are both plausible typos away, and both would be destroyed silently, so
# the destination is checked before anything is written.
#
# Traversal is refused rather than resolved: a lexical prefix test is only sound
# on a path with no `..` in it — `/home/pmeenan/src/../../var/www/...` matches
# the pattern below and lands in the docroot — and the destination is remote, so
# there is no local `realpath` to canonicalise with.
target="$REPO/pipeline/"
case "$target" in
  *..*)
    echo "refusing to sync to '$target': it contains '..'" >&2
    exit 2
    ;;
esac
case "$target" in
  /home/pmeenan/src/*/pipeline/) ;;
  *)
    echo "refusing to sync to '$target'" >&2
    echo "the destination must be /home/pmeenan/src/<project>/pipeline/ — never the" >&2
    echo "docroot or cve.pub/, which --delete would erase (D-018, D-053)" >&2
    exit 2
    ;;
esac

echo "pushing the WORKING tree — the checkout stays dirty until this is committed" >&2
rsync -avz --delete \
  --exclude '__pycache__' \
  --exclude 'pub' \
  --exclude 'published.json' \
  --human-readable \
  pipeline/ "$HOST:$target"
ssh "$HOST" "git -C '$REPO' status --short -- pipeline | head -20" >&2
