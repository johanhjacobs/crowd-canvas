#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  cat <<'EOF'
Usage:
  scripts/ops/run-loadtest-containers.sh <ws-url> [options]

Options:
  --containers N           number of load-generator containers (default 2)
  --clients N              total clients across all containers (default 2000)
  --rate N                 total connection ramp across all containers (default 400)
  --draw-min S             min draw time seconds (default 20)
  --draw-max S             max draw time seconds (default 40)
  --tiles N                tiles per client, 0 = until done (default 0)
  --duration S             duration per container in seconds (default 120)
  --network MODE           docker network mode, usually host or bridge (default host)
  --name-prefix NAME       container name prefix (default crowd-load)
  --insecure               pass --insecure to loadtest.js
  --build                  rebuild the loadtest image before starting

Example:
  scripts/ops/run-loadtest-containers.sh ws://127.0.0.1:3000/ws \
    --containers 3 --clients 20000 --rate 900 --duration 180
EOF
  exit 1
fi

URL="$1"
shift

CONTAINERS=2
CLIENTS_TOTAL=2000
RATE_TOTAL=400
DRAW_MIN=20
DRAW_MAX=40
TILES=0
DURATION=120
NETWORK_MODE=host
NAME_PREFIX=crowd-load
INSECURE=false
REBUILD=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --containers) CONTAINERS="$2"; shift 2 ;;
    --clients) CLIENTS_TOTAL="$2"; shift 2 ;;
    --rate) RATE_TOTAL="$2"; shift 2 ;;
    --draw-min) DRAW_MIN="$2"; shift 2 ;;
    --draw-max) DRAW_MAX="$2"; shift 2 ;;
    --tiles) TILES="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --network) NETWORK_MODE="$2"; shift 2 ;;
    --name-prefix) NAME_PREFIX="$2"; shift 2 ;;
    --insecure) INSECURE=true; shift ;;
    --build) REBUILD=true; shift ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p logs

IMAGE_NAME="crowd-canvas-loadtest:local"

if [[ "$REBUILD" == true ]] || ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  echo "Building $IMAGE_NAME ..."
  docker build -f Dockerfile.loadtest -t "$IMAGE_NAME" .
fi

clients_for() {
  local idx="$1"
  local base=$(( CLIENTS_TOTAL / CONTAINERS ))
  local rem=$(( CLIENTS_TOTAL % CONTAINERS ))
  if (( idx < rem )); then
    echo $(( base + 1 ))
  else
    echo "$base"
  fi
}

rate_for() {
  local idx="$1"
  local base=$(( RATE_TOTAL / CONTAINERS ))
  local rem=$(( RATE_TOTAL % CONTAINERS ))
  if (( idx < rem )); then
    echo $(( base + 1 ))
  else
    echo "$base"
  fi
}

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

for idx in $(seq 0 $((CONTAINERS - 1))); do
  NAME="${NAME_PREFIX}-$((idx + 1))"
  LOG_FILE="logs/${NAME}-${TIMESTAMP}.log"
  CLIENTS="$(clients_for "$idx")"
  RATE="$(rate_for "$idx")"

  docker rm -f "$NAME" >/dev/null 2>&1 || true

  echo "Starting $NAME: clients=$CLIENTS rate=$RATE log=$LOG_FILE"

  CMD=(node loadtest.js "$URL"
    --clients "$CLIENTS"
    --rate "$RATE"
    --draw-min "$DRAW_MIN"
    --draw-max "$DRAW_MAX"
    --tiles "$TILES"
    --duration "$DURATION"
  )

  if [[ "$INSECURE" == true ]]; then
    CMD+=(--insecure)
  fi

  docker run -d --rm \
    --name "$NAME" \
    --entrypoint sh \
    --network "$NETWORK_MODE" \
    --ulimit nofile=100000:100000 \
    -v "$ROOT_DIR/logs:/app/logs" \
    "$IMAGE_NAME" \
    -lc "$(printf '%q ' "${CMD[@]}") | tee /app/$LOG_FILE" >/dev/null
done

echo
echo "Running containers:"
docker ps --filter "name=${NAME_PREFIX}-" --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}'
echo
echo "Logs are in $ROOT_DIR/logs"
