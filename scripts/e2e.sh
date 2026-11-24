#!/usr/bin/env bash
set -euo pipefail
root=$(pwd)
collector=$(python3 scripts/collector.py)
consumer=$(mktemp -d)
trap 'rm -rf "$consumer"' EXIT
mkdir -p output
bun pm pack --destination "$consumer"
cp test/consumer.mjs "$consumer/"
cd "$consumer"
tarball=$(echo defuss-o11y-*.tgz)
printf '%s\n' '{"name":"o11y-clean-consumer","type":"module","private":true}' > package.json
bun add "./$tarball" express@5.3.0
for runtime in node bun; do
  "$runtime" consumer.mjs "$collector" "$root/output/$runtime.json"
done
# VERIFIED: users install with npm as well as Bun (maintainer requirement), so a clean npm consumer runs the same tarball.
mkdir npm && cd npm
cp ../consumer.mjs .
printf '%s\n' '{"name":"o11y-npm-consumer","type":"module","private":true}' > package.json
npm install --no-audit --no-fund "../$tarball" express@5.3.0
node consumer.mjs "$collector" "$root/output/npm-node.json"
