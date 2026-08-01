#!/usr/bin/env bash
# D-003: deployment is an rsync of dist/ to plex:/var/www/meenan.dev/cve/.
# No staged rollouts, no backups, no build step on the server.
#
# --delete is deliberate: the docroot mirrors dist/. Served data does NOT live
# there — it is in the cve.data/pub peer directory behind an nginx alias
# (D-018, D-034) — which is exactly why --delete is safe here.
set -euo pipefail

TARGET="${DEPLOY_TARGET:-plex:/var/www/meenan.dev/cve/}"
cd "$(dirname "$0")/.."

if [[ ! -f dist/index.html ]]; then
  echo "dist/ is not built — run 'pnpm build' first" >&2
  exit 1
fi

exec rsync -avz --delete --human-readable dist/ "$TARGET"
