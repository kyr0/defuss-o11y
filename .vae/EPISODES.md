# Episodes

<!-- Newest last. The gate appends FAIL|DONE|FINDING; past 100 entries it trims only its own oldest DONE|FAIL|learned
FINDING (git keeps them). Leads (LESSON, FINDING learn=none) stay until wrap settles them; doctor fails above 30.
Agents append `<UTC ISO> s=<session> LESSON <VAE-DIALECT>` only for a falsified HYPOTHESIS, a dead end, or a root cause.
Session start injects the 3 newest open entries: LESSON, FINDING learn=none, FAIL without a later DONE.
Wrap: EVERY lead becomes a test | .vae/VERIFY.py rule | one MEMORY line with BC, then delete; OR delete BC evidence. -->

2026-11-22T21:49:32Z s=o11y-rel FAIL prose
2026-11-22T21:52:14Z s=o11y-rel DONE fp=c21cdbbebe23 cov=99.5% paths=AGENTS.md,ARCH.md,Makefile,README.md(+20)
2026-11-22T21:52:14Z s=o11y-rel FINDING src/observations.ts|observations learn=test: A failing observer and a shrinking snapshot must withdraw stale gauge series on the next collection.
2026-11-22T21:52:14Z s=o11y-rel FINDING src/metrics.ts|sink.setGauge learn=test: The same gauge name with two queue labels must preserve both values independently over successive scrapes.
2026-11-23T19:29:39Z s=o11y-020 DONE fp=8ab1f2dcbe9c cov=99.8% paths=AGENTS.md,ARCH.md,Makefile,README.md(+23)
2026-11-23T19:29:39Z s=o11y-020 FINDING src/series.ts|seriesPolicy learn=test: The interval-order regression runs against a real SDK reader.
2026-11-23T19:29:39Z s=o11y-020 FINDING src/health.ts|check learn=test: An abort-ignoring callback runs under both runtime timers.
2026-11-23T19:29:39Z s=o11y-020 FINDING src/metrics.ts|claim learn=test: The public API rejects the conflicting name.
2026-11-23T20:48:10Z s=o11y-030 DONE fp=4e189a21cda2 cov=100.0% paths=ARCH.md,README.md,bun.lock,package.json(+12)
2026-11-23T20:48:10Z s=o11y-030 FINDING src/series.ts|LabelSchema.point learn=test: Collector end-to-end asserts normal and overflow totals, original and projected key spelling and duplicate-observer withdrawal.
2026-11-23T20:48:10Z s=o11y-030 FINDING src/push.ts|PushReader learn=test: Separate local HTTP endpoints exercise rejects, timeouts, overlap, callback failures, periodic export and recovery.
2026-11-23T20:48:10Z s=o11y-030 FINDING src/metrics.ts|defineHistogram learn=test: The Collector fixture verifies the three boundaries, four counts and the original OTLP unit.
2026-11-23T20:48:10Z s=o11y-030 FINDING src/http.ts|handle learn=test: API tests verify 404, 405, HEAD and fallthrough. Both defuss-serve runtimes route static files and a second application plugin.
2026-11-23T22:40:44Z s=31b15f7c FAIL docs.pages,prose,env.example,package,tests.unit,tests.e2e.1,coverage
2026-11-23T22:45:13Z s=31b15f7c FAIL package
2026-11-23T23:05:30Z s=31b15f7c DONE fp=d12f8b859e2b cov=100.0% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+52)
2026-11-23T23:05:30Z s=31b15f7c FINDING src/index.ts:observe|src/metrics.ts:validateMetadata learn=test: test/service.test.mjs observer test rejects description 42|null and options null, then registers the same name and scrapes it
2026-11-23T23:05:30Z s=31b15f7c FINDING benchmarks/package.json:6|benchmarks/compare.sh:7|examples/backplane/package.json:11|examples/serve/package.json:6 learn=verifier: .vae/VERIFY.py rule paths.in-repo-release (not_regex \.\./defuss-o11y/)
2026-11-23T23:05:30Z s=31b15f7c FINDING .env.example learn=verifier: existing gate check env.example
2026-11-23T23:05:30Z s=31b15f7c FINDING benchmarks/package.json|examples/backplane/package.json|examples/serve/package.json learn=verifier: existing gate check package
2026-11-23T23:05:30Z s=31b15f7c FINDING AGENTS.md:5,6,7,13,14 T06 learn=memory: plugin template defect outside this repo; .vae/MEMORY.md line for future init runs
2026-11-23T23:05:30Z s=31b15f7c FINDING ARCH.md:44 learn=none: page coverage of a topic is semantic, no rule kind expresses it
2026-11-23T23:05:30Z s=31b15f7c FINDING examples/backplane/README.md:13 P07 learn=none: one-off wording; no mechanical recurrence
2026-11-23T23:05:30Z s=31b15f7c FINDING verification/README.md:14 learn=verifier: same layout root cause as the sub-package paths; rule paths.in-repo-release
2026-11-23T23:31:58Z s=31b15f7c DONE fp=a7deb34df853 cov=100.0% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+52)
2026-11-24T01:09:41Z s=31b15f7c DONE fp=c88a930793f8 cov=100.0% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+38)
2026-11-24T01:09:41Z s=31b15f7c FINDING examples/serve/package.json:15|examples/backplane/package.json:15|benchmarks/package.json:10 learn=verifier: .vae/VERIFY.py rule paths.in-repo-release now also rejects ../release/ paths
2026-11-24T01:09:41Z s=31b15f7c FINDING scripts/e2e.sh:16 learn=memory: .vae/MEMORY.md records the no-tarball, no-provenance-snapshot preference; no rule kind expresses absence of a generated file
2026-11-24T17:42:06Z s=31b15f7c DONE fp=81c621f2122d cov=100.0% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+38)
2026-11-24T17:42:06Z s=31b15f7c FINDING examples/serve/package.json:14|examples/serve/verify.mjs:35|README.md:164 learn=none: one-off dependency source switch; the verifier now reports the installed version instead of a literal
2026-11-24T18:17:04Z s=31b15f7c DONE fp=dc2d3120e422 cov=100.0% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+38)
2026-11-24T18:17:04Z s=31b15f7c FINDING package.json:52|src/index.ts:12,19|src/metrics.ts:2|src/series.ts:1|test/contracts.ts:2 learn=verifier: maintainer requirement; .vae/VERIFY.py rule deps.no-open-telemetry-bridge rejects the package as a package.json dependency
2026-11-24T18:33:07Z s=31b15f7c DONE fp=c11048afd526 cov=100.0% paths=.github/workflows/verify.yml,AGENTS.md,ARCH.md,Makefile(+38)
