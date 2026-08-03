#!/usr/bin/env bash
# Put `pipeline/` on plex, where the crons run it (D-042, D-058).
#
# This is NOT the docroot deploy. `scripts/deploy.sh` mirrors `dist/` into the
# served directory; the pipeline must never go there (D-018, D-053) and does not.
# It lands under /home/pmeenan/src/, where the other projects on that machine
# live — but as a plain directory, not a git clone.
#
# **rsync is the deployment model, and the destination is not git-managed.**
# Agents never commit (AGENTS.md rule 7), so a pipeline change cannot reach the
# server through git until the human gate closes, and the first production
# ingest ran with the change still in the working tree. Making the destination a
# real checkout and pulling into it instead is a possible future change, not a
# state anything can rely on today — so do not describe production as
# git-managed while this is what puts the code there.
set -euo pipefail

TARGET="${PIPELINE_TARGET:-plex:/home/pmeenan/src/meenan.dev/cve/pipeline/}"
cd "$(dirname "$0")/.."

# `rsync --delete` mirrors deletions, so a wrong destination does not fail — it
# empties something and fills it with Python. The docroot and the published data
# plane are both plausible typos away, and both would be destroyed silently, so
# the destination is checked against a narrow shape before anything is created.
path="${TARGET#*:}"
# Checked *after* rejecting traversal, because a lexical prefix test is only
# meaningful on a path with no `..` in it: `/home/pmeenan/src/../../var/www/...`
# matches the pattern below and resolves to the docroot. The destination is
# remote, so there is no local `realpath` to canonicalise with — refusing the
# component outright is both simpler and stricter than resolving it.
case "$path" in
  *..*)
    echo "refusing to sync to '$path': it contains '..'" >&2
    echo "the destination must be a literal path, so that checking it means something" >&2
    exit 2
    ;;
esac
case "$path" in
  /home/pmeenan/src/*/pipeline/) ;;
  *)
    echo "refusing to sync to '$path'" >&2
    echo "the destination must be /home/pmeenan/src/<project>/pipeline/ — never the" >&2
    echo "docroot or cve.pub/, which --delete would erase (D-018, D-053)" >&2
    exit 2
    ;;
esac

# rsync will not create intermediate directories, and this is a plain directory
# that may not exist yet on a fresh machine.
if [[ "$TARGET" == *:* ]]; then
  ssh "${TARGET%%:*}" "mkdir -p '$path'"
else
  mkdir -p "$path"
fi

exec rsync -avz --delete \
  --exclude '__pycache__' \
  --exclude 'pub' \
  --exclude 'published.json' \
  --human-readable \
  pipeline/ "$TARGET"
