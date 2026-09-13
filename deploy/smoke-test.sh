#!/bin/sh
set -eu
image=${1:?usage: smoke-test.sh image}
container=$(docker run -d -e DEFAULT_API_URL=https://api.sakrylle.com/v1 -e OIDC_ENABLED=true "$image")
trap 'docker rm -f "$container" >/dev/null' EXIT
attempt=0
until docker exec "$container" curl -sf http://127.0.0.1/ -o /tmp/smoke-home; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || exit 1
  sleep 1
done
docker exec "$container" sh -eu -c '
  nginx -t
  if grep -R -E "__VITE_[A-Z_]+_PLACEHOLDER__" /usr/share/nginx/html/assets >/dev/null; then
    echo "Unreplaced runtime placeholder" >&2; exit 1
  fi
  grep -R -q "https://api.sakrylle.com/v1" /usr/share/nginx/html/assets
  grep -R -q "https://oidc1.sakrylle.com" /usr/share/nginx/html/assets
  ! grep -q "proxy_pass" /etc/nginx/conf.d/default.conf
  grep -q "sakrylle-image-playground-v0.12.1" /usr/share/nginx/html/sw.js
'
echo 'Docker runtime smoke test passed (direct API, OAuth/OIDC, placeholders, SW).'
