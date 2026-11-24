# Agent memory

<!-- One tagged line per durable fact NOT derivable from code, git or docs:
- VERIFIED[scope] fact BC evidence
- HYPOTHESIS[scope] claim BC observation; falsifier=`cmd`
- UNKNOWN[scope] gap BC missing evidence
[scope] = the narrowest path|module|command|condition the evidence covers, not a topic: the entry decides nothing
outside it, and recurrence inside one subsystem never widens it.
Every line carries its BC and stays within 240 chars. Replace stale lines instead of appending.
Mechanizable lessons belong in tests or .vae/VERIFY.py.
Budget 4 KiB (`vae.py doctor --repo .`); entries are injected at session start. -->
- VERIFIED[`vae.py init`@defuss-vae 0.9.0] init rewrites the AGENTS.md managed block with arrows that fail prose T06 BC observed on both init runs 2026-11-23; after init, rewrite those 5 arrows as words
- VERIFIED[repo layout] the maintainer wants no committed release tarballs and no provenance snapshots (checksum manifests, copied gate logs, review|docs attestations) BC request 2026-11-24; examples/* and benchmarks are bun workspaces on `workspace:*`, the gate's own tmp/vae attestations are the evidence
