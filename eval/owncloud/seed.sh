#!/usr/bin/env bash
# Creates user "e2e" and uploads three sample files. Safe to run twice.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "seed.sh: .env missing; copy .env.example and fill it in" >&2; exit 1; }
set -a; . ./.env; set +a
: "${E2E_PASSWORD:?E2E_PASSWORD not set in .env}"
BASE=http://localhost:8080
C="docker compose -f docker-compose.yml"

curl -sf "$BASE/status.php" | grep -q '"installed":true' ||
  { echo "seed.sh: server not up at $BASE (run: docker compose -f eval/owncloud/docker-compose.yml up -d, wait for it to start)" >&2; exit 1; }

if $C exec -T owncloud occ user:list | grep -q -- '- e2e:'; then
  echo "user e2e exists"
else
  $C exec -T -e OC_PASS="$E2E_PASSWORD" owncloud occ user:add --password-from-env --display-name="E2E" e2e
fi

put() { # name content
  printf '%s\n' "$2" | curl -sf -u "e2e:$E2E_PASSWORD" -T - "$BASE/remote.php/dav/files/e2e/$1" -o /dev/null ||
    { echo "seed.sh: upload of $1 failed" >&2; exit 1; }
  echo "uploaded $1"
}
put e2e-notes.txt "Sample notes for the ownCloud evaluation."
put e2e-todo.md "# Todo
- check upload
- check download"
put e2e-data.csv "id,name
1,alpha
2,beta"
