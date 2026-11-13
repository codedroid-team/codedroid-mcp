#!/usr/bin/env bash
# Creates user "e2e" and uploads three sample files. Safe to run twice.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "seed.sh: .env missing; copy .env.example and fill it in" >&2; exit 1; }
set -a; . ./.env; set +a
[ -n "${E2E_PASSWORD:-}" ] || { echo "seed.sh: E2E_PASSWORD not set in eval/owncloud/.env" >&2; exit 1; }
if [ "$E2E_PASSWORD" = change-me ] || [ "${ADMIN_PASSWORD:-}" = change-me ]; then
  echo "seed.sh: placeholder password; generate real values (openssl rand -hex 12) in eval/owncloud/.env" >&2; exit 1
fi
BASE=http://localhost:8080
C="docker compose -f docker-compose.yml"

curl -sf "$BASE/status.php" | grep -q '"installed":true' ||
  { echo "seed.sh: server not up at $BASE (run: docker compose -f eval/owncloud/docker-compose.yml up -d, wait for it to start)" >&2; exit 1; }

if $C exec -T owncloud occ user:list | grep -q -- '- e2e:'; then
  echo "user e2e exists"
else
  OC_PASS="$E2E_PASSWORD" $C exec -T -e OC_PASS owncloud occ user:add --password-from-env --display-name="E2E" e2e
fi

put() { # name content
  local body; body=$(mktemp); printf '%s\n' "$2" > "$body"
  # credentials go through a config on stdin, not argv
  printf 'user = "e2e:%s"\n' "$E2E_PASSWORD" | curl -sf -K - -T "$body" "$BASE/remote.php/dav/files/e2e/$1" -o /dev/null ||
    { rm -f "$body"; echo "seed.sh: upload of $1 failed" >&2; exit 1; }
  rm -f "$body"
  echo "uploaded $1"
}
put e2e-notes.txt "Sample notes for the ownCloud evaluation."
put e2e-todo.md "# Todo
- check upload
- check download"
put e2e-data.csv "id,name
1,alpha
2,beta"
