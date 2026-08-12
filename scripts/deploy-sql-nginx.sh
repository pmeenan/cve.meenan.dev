#!/usr/bin/env bash
# Install the hosted query tier's nginx limits (D-084). Run as root ON plex:
#
#     sudo bash ~/src/meenan.dev/cve/scripts/deploy-sql-nginx.sh
#
# Companion to deploy-chat-nginx.sh and the same shape: split
# scripts/nginx-sql.conf into the two files nginx needs, show the one line
# that still has to be added by hand, test the config. It does **not** edit
# sites-available/meenan.dev.
#
# PRECONDITION: the chat zones file must already be installed — the SQL zones
# key on the visitor address that cve-chat-zones.conf's real_ip block
# resolves from CF-Connecting-IP (RE-031). Without it the limits key on a
# Cloudflare edge and are wrong in both directions at once.
set -euo pipefail

SOURCE="$(cd "$(dirname "$0")" && pwd)/nginx-sql.conf"
ZONES=/etc/nginx/conf.d/cve-sql-zones.conf
CHAT_ZONES=/etc/nginx/conf.d/cve-chat-zones.conf
LOCATION=/etc/nginx/cve-sql.conf
SITE=/etc/nginx/sites-available/meenan.dev

[[ $EUID -eq 0 ]] || { echo "run me as root" >&2; exit 1; }
[[ -f $SOURCE ]] || { echo "cannot find $SOURCE" >&2; exit 1; }
[[ -f $CHAT_ZONES ]] || {
  echo "$CHAT_ZONES is missing — install the chat relay's zones first" >&2
  echo "(deploy-chat-nginx.sh); the SQL limits key on the visitor address" >&2
  echo "its real_ip block resolves, and are meaningless without it (RE-031)." >&2
  exit 1
}
grep -q 'real_ip_header' "$CHAT_ZONES" || {
  echo "$CHAT_ZONES carries no real_ip configuration — refusing" >&2; exit 1;
}

awk '/^# PIECE 1 —/{p=1;next} /^# PIECE 2 —/{p=0} p' "$SOURCE" \
  | grep -vE '^\s*#' | grep -vE '^\s*$' > "$ZONES"
awk '/^location = \/api\/sql\.php \{/{p=1} p{print} /^\}/{if(p)exit}' "$SOURCE" > "$LOCATION"

grep -q 'limit_req_zone' "$ZONES" || { echo "zone extraction produced nothing" >&2; exit 1; }
grep -q 'cve_sql_global' "$ZONES" || { echo "zones lost the global concurrency cap" >&2; exit 1; }
grep -q 'fastcgi_pass' "$LOCATION" || { echo "location extraction produced nothing" >&2; exit 1; }
[[ $(grep -c '{' "$LOCATION") -eq $(grep -c '}' "$LOCATION") ]] \
  || { echo "location block is unbalanced" >&2; exit 1; }

echo "wrote $ZONES:"; sed 's/^/    /' "$ZONES"
echo "wrote $LOCATION ($(wc -l < "$LOCATION") lines)"

if grep -q 'include cve-sql.conf;' "$SITE"; then
  echo "$SITE already includes cve-sql.conf"
else
  cat <<EOF

STILL TO DO BY HAND — add this line to the cve.meenan.dev server block in
$SITE, immediately before 'include php.conf;':

    include cve-sql.conf;

Then re-run: nginx -t && systemctl reload nginx
EOF
  exit 0
fi

nginx -t && systemctl reload nginx && echo "reloaded"
