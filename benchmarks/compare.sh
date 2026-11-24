#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
bun install --frozen-lockfile
bun run --cwd .. build
mkdir -p results
for runtime in node bun; do
  "$runtime" ../scripts/benchmark.mjs node_modules/defuss-o11y/dist/index.js node_modules/o11y-baseline/dist/index.js > "results/$runtime.json"
done
