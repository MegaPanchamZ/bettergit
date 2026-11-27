#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
runner=bench
if [[ "${1:-}" == --realistic ]]; then
  runner=realistic
  shift
  if [[ -z "${BETTERGIT_BINARY:-}" ]]; then
    BETTERGIT_BINARY="$root/target/debug/bettergit"
  fi
  if ! command -v -- "$BETTERGIT_BINARY" >/dev/null; then
    echo 'Build Better Git with cargo build --locked or set BETTERGIT_BINARY to its absolute path.' >&2
    exit 1
  fi
  BETTERGIT_BINARY=$(command -v -- "$BETTERGIT_BINARY")
  BETTERGIT_BINARY=$(realpath -- "$BETTERGIT_BINARY")
  export BETTERGIT_BINARY
fi
project="bettergit-bench-$(date +%s)-$$"
compose() { docker compose --project-name "$project" --file tests/forgejo/compose.yaml "$@"; }
sampler=
cleanup() {
  if [[ -n "$sampler" ]]; then
    kill "$sampler" 2>/dev/null || true
    wait "$sampler" 2>/dev/null || true
  fi
  compose down --volumes --remove-orphans >&2
}
trap cleanup EXIT
compose up -d --wait >&2
url="http://$(compose port forgejo 3000)"
for attempt in {1..60}; do
  if curl -fsS --max-time 2 "$url/api/v1/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --max-time 3 "$url/api/v1/version" >/dev/null
setup=$(compose exec -T -u git forgejo forgejo admin user create --config /data/gitea/conf/app.ini \
  --username benchadmin --password 'Forgejo-local-disposable-admin!' --email admin@example.test \
  --admin --must-change-password=false --access-token --access-token-name bettergit-bench)
token=$(awk '/[Aa]ccess token/ {print $NF}' <<< "$setup")
if [[ ! "$token" =~ ^[a-fA-F0-9]{40}$ ]]; then
  echo 'Forgejo did not generate the fixture administrator token.' >&2
  exit 1
fi
if [[ -n "${BENCH_TELEMETRY_FILE:-}" ]]; then
  containers=()
  while IFS= read -r container; do containers+=("$container"); done < <(compose ps -q)
  (
    while :; do
      timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      docker stats --no-stream --format '{{json .}}' "${containers[@]}" |
        while IFS= read -r row; do
          printf '{"time":"%s","container":%s}\n' "$timestamp" "$row"
        done
      sleep 3
    done
  ) >> "$BENCH_TELEMETRY_FILE" &
  sampler=$!
fi
FORGEJO_TEST_URL="$url" FORGEJO_TEST_TOKEN="$token" \
  DATABASE_URL="postgres://bench:disposable-local-db@$(compose port control-db 5432)/bettergit" \
  node --import ./control-plane/node_modules/tsx/dist/loader.mjs "tests/forgejo/$runner.mts" "$@"
