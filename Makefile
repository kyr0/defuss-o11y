.DEFAULT_GOAL := help
.PHONY: help setup build lint test coverage e2e verify start stop status log metrics bench
-include .env
export OTELCOL_BIN

help: ## list development commands
	@awk -F ':.*## ' '/^[a-z]+:.*##/ {print $$1 "  " $$2}' Makefile
setup: ## install locked dependencies with the pinned Bun
	bun install --frozen-lockfile
build: ## compile JS and declarations
	bun run build
lint: ## lint and check TypeScript contracts
	bun run lint
test: build ## run the API suite on Node and Bun
	node --test test/*.test.mjs
	bun test test/*.test.mjs
coverage: build ## measure source coverage on Node
	bunx --no-install c8 --all --src dist --include 'dist/index.js' --reporter=text --check-coverage --lines 80 node --test test/*.test.mjs
e2e: build ## install the tarball and exercise real Collector receivers on both runtimes
	bash scripts/e2e.sh
verify: lint test coverage e2e ## run all checks
start stop status log: ## lifecycle belongs to the host application
	@echo "Library; run the host application."
metrics: build ## print runtime metrics from the built package
	@node --input-type=module -e 'import {createO11y} from "./dist/index.js";const o=createO11y({serviceName:"local"}); console.log(await o.metrics()); await o.shutdown()'
bench: build ## measure recording and scrapes under label churn
	node scripts/benchmark.mjs
	bun scripts/benchmark.mjs
