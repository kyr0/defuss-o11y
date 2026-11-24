# CLI gist

<!-- Commands future agents need that the Makefile verbs do not cover (setup, env, data, deploy):
- VERIFIED[purpose] `cmd`: only after an observed success
- UNKNOWN[purpose] BC gap
Budget 2 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[pinned runtimes in agent sandbox] `export PATH=$HOME/.local/share/mise/installs/node/24.22.3/bin:$HOME/.local/share/mise/installs/bun/1.4.5/bin:$PATH BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache` BC `mise exec` and ~/.bun cache writes hit EPERM
- VERIFIED[make test|coverage|e2e in agent sandbox] need local port binding: run unsandboxed or set `sandbox.network.allowLocalBinding` BC listen EPERM 127.0.0.1
- VERIFIED[Collector fetch behind sandbox proxy] urllib gets a truncated archive (checksum mismatch): `curl -sSL` the 0.165.0 tarball, check sha256 against scripts/collector.py, extract `otelcol` to .cache/otelcol/0.165.0/<os>_<arch>/
