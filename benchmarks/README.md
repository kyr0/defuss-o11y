# Release comparison

Run `bash compare.sh` in this directory with Node and Bun on PATH. The harness builds this checkout and compares it with the 0.2.0 baseline tarball in `vendor/`. Each runtime runs alone and writes its own JSON under `results/`. Both versions use the same instrumentation dependency versions. The library's `make bench` runs the current implementation on its own.

The churn workload records 100 new worker labels per in-process collection. At each checkpoint it discards two warm-ups and takes 21 scrape samples. Response bytes include all exposition metadata. The harness asserts the exact number of counter series, total increments and overflow value at every checkpoint. The two 0.3.0 profiles use the default 2000 and a per-counter override of 256.

The fixed-label workload rotates the measurement order across 11 blocks of 60,000 writes. It records nine block means per API in microseconds per write. Every case uses the same three attributes and a real collecting SDK reader. The counter totals must match before results are emitted. Timings describe this machine and workload.

## Release measurements

These figures were measured with the 0.3.0 release. Median in-process scrape at 10,000 writes with 10,000 worker values. Every row exported a total of 10,000. The JSON files also contain all individual samples and fixed-label recording costs.

| Runtime | Release and budget | Counter series | Median ms |
| --- | --- | ---: | ---: |
| node 24.22.3 | v0.2 default | 2,001 | 4.90 |
| node 24.22.3 | v0.2 limit 256 | 257 | 0.58 |
| node 24.22.3 | v0.3 default | 2,001 | 5.89 |
| node 24.22.3 | v0.3 limit 256 | 257 | 0.56 |
| bun 1.4.5 | v0.2 default | 2,001 | 3.93 |
| bun 1.4.5 | v0.2 limit 256 | 257 | 0.37 |
| bun 1.4.5 | v0.3 default | 2,001 | 3.46 |
| bun 1.4.5 | v0.3 limit 256 | 257 | 0.41 |
