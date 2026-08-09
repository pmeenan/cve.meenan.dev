#!/usr/bin/env bash
# Install the chat relay's nginx limits (M7, D-057). Run as root ON plex:
#
#     sudo bash ~/src/meenan.dev/cve/scripts/deploy-chat-nginx.sh
#
# The limits are a ship requirement, not a nicety: absence-of-CORS stops a
# cross-site browser and does nothing about curl, and the relay is
# unauthenticated inference on a box with one small GPU.
#
# It splits scripts/nginx-chat.conf into the two files nginx needs, shows the
# one line that still has to be added by hand, and tests the config. It does
# **not** edit sites-available/meenan.dev — an automated edit of a
# certbot-managed file is how a site stops serving at 2 a.m.
set -euo pipefail

SOURCE="$(cd "$(dirname "$0")" && pwd)/nginx-chat.conf"
ZONES=/etc/nginx/conf.d/cve-chat-zones.conf
LOCATION=/etc/nginx/cve-chat.conf
SITE=/etc/nginx/sites-available/meenan.dev

[[ $EUID -eq 0 ]] || { echo "run me as root" >&2; exit 1; }
[[ -f $SOURCE ]] || { echo "cannot find $SOURCE" >&2; exit 1; }

# The two pieces are delimited by their PIECE banners, so the file stays one
# readable document in the repo and this stays a split rather than a duplicate.
# Everything between the banners that is not a comment or a blank line. A
# grep for `limit_*_zone` would have been simpler and was, until the zones
# grew a multi-line `map` block — at which point it would have silently
# dropped the definition of the variable the zones key on, and nginx would
# have failed to start on an undefined variable.
awk '/^# PIECE 1 —/{p=1;next} /^# PIECE 2 —/{p=0} p' "$SOURCE" \
  | grep -vE '^\s*#' | grep -vE '^\s*$' > "$ZONES"
awk '/^location = \/api\/chat\.php \{/{p=1} p{print} /^\}/{if(p)exit}' "$SOURCE" > "$LOCATION"

grep -q 'limit_req_zone' "$ZONES" || { echo "zone extraction produced nothing" >&2; exit 1; }
grep -q 'real_ip_header' "$ZONES" || { echo "zones lost the real_ip configuration" >&2; exit 1; }
# Behind Cloudflare the limits are worthless without the trusted-proxy list —
# they key on an edge address instead of the visitor (RE-031, D-079).
[[ $(grep -c '^set_real_ip_from' "$ZONES") -ge 10 ]] \
  || { echo "too few set_real_ip_from ranges — refresh from cloudflare.com/ips-v4" >&2; exit 1; }
grep -q 'fastcgi_pass' "$LOCATION" || { echo "location extraction produced nothing" >&2; exit 1; }
# Brace balance, because the location extraction stops at the first line that
# is exactly `}` — a nested block would truncate it into invalid config.
[[ $(grep -c '{' "$LOCATION") -eq $(grep -c '}' "$LOCATION") ]] \
  || { echo "location block is unbalanced" >&2; exit 1; }

echo "wrote $ZONES:"; sed 's/^/    /' "$ZONES"
echo "wrote $LOCATION ($(wc -l < "$LOCATION") lines)"

if grep -q 'include cve-chat.conf;' "$SITE"; then
  echo "$SITE already includes cve-chat.conf"
else
  cat <<EOF

STILL TO DO BY HAND — add this line to the cve.meenan.dev server block in
$SITE, immediately before 'include php.conf;':

    include cve-chat.conf;

Then re-run: nginx -t && systemctl reload nginx
EOF
  exit 0
fi

nginx -t && systemctl reload nginx && echo "reloaded"
