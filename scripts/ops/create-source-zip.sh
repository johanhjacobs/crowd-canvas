#!/usr/bin/env bash

set -euo pipefail

out="${1:-crowd-canvas-source-$(date +%Y%m%d-%H%M%S).zip}"

zip -r "$out" . \
  -x '.git/*' \
  -x 'node_modules/*' \
  -x 'data/*' \
  -x 'logs/*' \
  -x 'reports/*' \
  -x '.indigo/*' \
  -x '.DS_Store' \
  -x '**/.DS_Store' \
  -x '.vscode/*' \
  -x '.idea/*' \
  -x '*~' \
  -x '*.swp' \
  -x '*.swo'

printf 'Created %s\n' "$out"
