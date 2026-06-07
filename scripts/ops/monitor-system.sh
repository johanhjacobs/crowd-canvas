#!/usr/bin/env bash

set -euo pipefail

interval="${1:-2}"
out="${2:-logs/system-monitor-$(date +%Y%m%d-%H%M%S).log}"
target_port="${TARGET_PORT:-3000}"

mkdir -p "$(dirname "$out")"

log() {
  printf '%s\n' "$*" >>"$out"
}

snapshot_vmstat() {
  if command -v vmstat >/dev/null 2>&1; then
    vmstat 1 2 | tail -n 1
  else
    echo "vmstat unavailable"
  fi
}

socket_count() {
  if command -v ss >/dev/null 2>&1; then
    ss -Htan "( sport = :$target_port or dport = :$target_port )" 2>/dev/null | wc -l
  else
    echo "ss unavailable"
  fi
}

top_nodes() {
  ps -eo pid,ppid,%cpu,%mem,rss,etime,cmd --sort=-%cpu | awk '
    NR==1 { print; next }
    /node|loadtest/ { print; count++; if (count == 12) exit }
  '
}

{
  echo "# Crowd Canvas system monitor"
  echo "# started: $(date --iso-8601=seconds)"
  echo "# interval_seconds: $interval"
  echo "# target_port: $target_port"
  echo
} >"$out"

trap 'log ""; log "# stopped: $(date --iso-8601=seconds)"; exit 0' INT TERM

while true; do
  {
    echo "===== $(date --iso-8601=seconds) ====="
    echo "-- uptime --"
    uptime
    echo
    echo "-- memory --"
    free -h
    echo
    echo "-- vmstat (r b swpd free buff cache si so bi bo in cs us sy id wa st) --"
    snapshot_vmstat
    echo
    echo "-- socket_count_port_${target_port} --"
    socket_count
    echo
    echo "-- node_processes --"
    top_nodes
    echo
  } >>"$out"
  sleep "$interval"
done
