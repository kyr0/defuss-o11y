# defuss-o11y

Mount health probes and export application metrics from Node.js or Bun. A check returns a boolean. A metric observer returns a number or a snapshot of labeled values. The package supplies the HTTP responses, Prometheus formatter and OTLP exporter.

## Install and run

Install the package from the npm registry with Bun or npm:

```sh
bun add defuss-o11y
npm install defuss-o11y
```

The package is ESM and ships TypeScript declarations. It requires Node.js 22.15 or later, or Bun 1.4.5 or later. `make verify` tests it on Node.js 24.22.3 and Bun 1.4.5, the versions pinned in `mise.toml`.

To try it from a clone of this repository, run the Express example and its local Collector in separate terminals.

```sh
make setup
make build
otelcol --config=examples/collector-push.yaml
```

```sh
node examples/express.mjs
curl -i http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/metrics
```

## Express and Bun

```ts
import express from "express";
import { statfs } from "node:fs/promises";
import { createO11y } from "defuss-o11y";

const obs = createO11y({ serviceName: "backplane", otlp: true });
obs.check("storage", async () => (await statfs(".")).bavail > 0);
obs.observe("storage_free_bytes", async () => {
  const volume = await statfs(".");
  return volume.bavail * volume.bsize;
}, { unit: "By" });

const app = express();
app.use(obs.middleware);
app.listen(3000);
```

`app.use("/ops", obs.middleware)` moves all routes under `/ops`. Other paths continue through the host router. Bun can mount the same middleware in Express or serve the Fetch handler directly.

```ts
import { createO11y } from "defuss-o11y";

const obs = createO11y({ serviceName: "backplane" });
Bun.serve({ port: 3000, fetch: obs.fetch });
```

## HTTP and collection

| Operation | Consumer | Behavior |
| --- | --- | --- |
| GET /health, GET /readyz | Load balancer or readiness probe | All registered checks. HTTP 503 on any failure or after drain. |
| GET /healthz, GET /livez | Liveness probe | Only explicit liveness checks. Works with zero callbacks. |
| GET /metrics | Prometheus or a Collector Prometheus receiver | Prometheus text 0.0.4 with an explicit media type. |
| POST /v1/metrics on the Collector | OTLP exporter in the service | OTLP/HTTP JSON push, opt-in. The Collector receives the batch. |

Healthy probes return HTTP 200. The JSON body includes `service`, `status` and a `checks` array. Status values are `pass` and `fail`. This JSON schema belongs to the package. Kubernetes uses the HTTP result. All application routes support HEAD and set `Cache-Control: no-store`. Other methods on these routes receive 405. The Fetch handler returns 404 for unknown paths.

Choose one ingestion path per destination to avoid counting samples twice. For pull, run `otelcol --config=examples/collector-scrape.yaml` with the example on port 3000. For push, configure `otlp: true` and run the push configuration above. Both Collector examples use the debug exporter so the received metrics are visible locally.

`otlp: true` uses the SDK's endpoint resolution, including `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. The local default is `http://localhost:4318/v1/metrics`. To configure the full URL, credentials and timing explicitly:

```ts
const obs = createO11y({
  serviceName: "backplane",
  serviceVersion: "0.3.0",
  otlp: {
    endpoint: "http://127.0.0.1:4318/v1/metrics",
    intervalMs: 15_000,
    timeoutMs: 5_000,
  },
});
```

Set `otlp.headers` or the SDK's `OTEL_EXPORTER_OTLP_METRICS_HEADERS` for authenticated receivers. The default interval is 60 seconds. The OTLP timeout defaults to the smaller of 10 seconds and the interval. The callback deadline must be shorter than the OTLP timeout, and the timeout must fit within the interval.

## Checks and metrics

`check(name, callback, options?)` registers a readiness check by default and returns its disposer. Use the third argument `"liveness"` for a local condition that should trigger process restart. Readiness includes both kinds. A callback passes by returning or resolving to `true`. A false value, exception or timeout fails its check. Probe responses expose check names and bounded reason codes. Exceptions stay out of HTTP bodies and metric labels.

For an expensive check, pass `{ probe: "readiness", maxAgeMs: 1000 }`. A positive result stays valid for up to 1000 ms from callback completion. Readiness, applicable liveness checks and both metrics readers reuse that result. A dependency outage may remain hidden for the rest of the window. The default is zero. False, rejected and timed-out results are retried once the previous callback settles. Removing and re-registering the check starts with an empty cache. Draining immediately fails new readiness requests and skips checks for those requests.

`observe(name, callback, { description, unit }?)` registers a gauge producer for the instance lifetime. Return a finite number or an array of `{ value, attributes }`. An empty array withdraws every series for that observer. Losing one queue withdraws only that queue. If the callback throws, times out or returns invalid data, its series disappear for that collection and its success gauge becomes zero. Other observers still export.

```ts
obs.observe("queue_depth", async () => [
  { value: 4, attributes: { queue: "interactive" } },
  { value: 9, attributes: { queue: "batch" } },
]);

obs.sink.incrementCounter("jobs", 1, { result: "ok" });
obs.sink.recordHistogram("job_duration_seconds", 0.052);
obs.sink.setGauge("workers", 3, { pool: "io" });
obs.sink.setGauge("workers", 2, { pool: "cpu" });
```

The built-in gauges are process uptime in seconds, resident memory in bytes, readiness, per-check success and per-observer success. Check evaluation runs during readiness polling and metric collection. Use read-only callbacks. Pass the supplied AbortSignal to cancellable I/O. Concurrent consumers share an in-flight invocation. An expired call that ignores cancellation retains its slot until it settles. The default deadline is 1000 milliseconds. Set `timeoutMs` on the instance to change it. Synchronous code that blocks the event loop delays timers too.

## Series limits and fixed labels

```ts
const obs = createO11y({
  serviceName: "queue-api",
  maxSeriesPerInstrument: 2000,
  seriesLimits: { http_requests: 256 },
});
const recordVersion = obs.bindCounter("http_requests", { route: "/version", method: "GET" });
recordVersion(); // one request
```

Each instance accepts 256 active checks and 256 lifetime application instruments. Each synchronous instrument admits its first 2000 distinct label sets by default. Further sets share one additional overflow series. Set `maxSeriesPerInstrument` to change the default. Use the original instrument name in `seriesLimits` for an override. Admission lasts until shutdown. Later writes to an admitted label set still update its own series.

| Instrument | Excess label sets |
| --- | --- |
| Counter | Increments accumulate in the overflow counter. |
| Histogram | Every excess sample contributes to the overflow buckets, count and sum. |
| Synchronous gauge | The overflow gauge reports the most recent excess value. |
| Async gauge observer | The limit applies to each snapshot. Exceeding it fails that snapshot and sets observer success to zero. New label values can appear in the next snapshot. |

OTLP uses `otel.metric.overflow=true`. Prometheus exposes `otel_metric_overflow="true"`. Aggregating all counter or histogram series retains totals. Individual overflowed label values cannot be recovered. Budgets bound series counts. Scrape size still depends on label lengths and histogram bucket counts.

`bindCounter(name, attributes?)`, `bindHistogram(name, attributes?)` and `bindGauge(name, attributes?)` return recording functions. Binding snapshots the labels and reserves a slot. The first invocation records the first sample. The dynamic sink and bound handles share admission, instruments and validation. Keep a handle for a fixed route or queue. A counter increment defaults to one. Counters and histograms accept finite non-negative numbers. Gauges also accept negative values.

Metric names start with an ASCII letter and can include letters, digits, periods, hyphens and underscores. Label keys start with a letter and support dot-separated segments containing letters, digits and underscores. Empty segments are invalid. Repeated underscores and exporter-owned labels such as `le`, `quantile`, `otel_metric_overflow` and `otel_scope_*` are reserved. Each instrument accepts up to 128 distinct label keys over its lifetime.

**Migrating from 0.1.0.** Keep the type of each label key consistent per instrument. For example, choose either numeric HTTP status codes or strings throughout that instrument. A conflicting sink write or bind throws before recording. An invalid observer snapshot contributes no application points and commits no new key types. Each instrument has its own schema. A synchronous instrument exceeding its configured budget now aggregates excess dimensions. Set explicit budgets where individual label sets need to remain queryable.

## Histogram declarations and OpenTelemetry attributes

Declare bucket boundaries in the measurement unit before the first bind or write to that histogram. Undeclared histograms continue using the SDK defaults. Declarations reserve the instrument name and leave series admission to the first bind or write. Duplicate or late declarations throw.

```ts
obs.defineHistogram("http.server.request.duration", {
  unit: "s",
  description: "HTTP server request duration",
  explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10],
});
const record = obs.bindHistogram("http.server.request.duration", { "http.request.method": "GET" });
record(0.08);
```

Boundaries are copied at declaration and must be finite and strictly increasing. An empty array creates one catch-all bucket. Both readers use the declared boundaries for dynamic and bound writes. OTLP includes the unit in the metric descriptor. The Prometheus text endpoint emits a `# UNIT` comment. In the end-to-end test, the Collector 0.165.0 Prometheus receiver retained the description and buckets and left its converted OTLP unit field empty. Use OTLP push when downstream queries require that field.

**Migrating from 0.2.0.** Empty-string and undefined attributes are omitted on both export paths. A counter written with `{}` and `{ queue: "" }` now accumulates into one series. An observer returning those two identities in a single snapshot fails duplicate validation. Zero and false retain their values. OTLP preserves dotted keys such as `http.request.method`. Prometheus exposes `http_request_method`. A single instrument must use one spelling for each projected Prometheus key across calls. A colliding write throws, and a colliding observer snapshot fails atomically.

## Fetch composition

```ts
async function route(request: Request): Promise<Response> {
  return await obs.handle(request) ?? application.fetch(request);
}
```

`handle()` resolves to `undefined` on an unowned path and leaves the request body available to its next handler. A recognized path handles its own 405 and HEAD responses. `fetch()` produces the standalone 404. For hosts requiring a synchronous matcher, including defuss-serve 0.3.0, register `{ name: "o11y", matches: obs.matches, fetch: obs.fetch, close: obs.shutdown }`.

## Export outcomes

```ts
const service = createO11y({
  serviceName: "queue-api",
  otlp: {
    endpoint: "http://127.0.0.1:4318/v1/metrics",
    onExportError({ source, error }) { console.warn(source, error.message); },
  },
});
await service.flush({ strict: true });
```

Strict flush resolves after the receiver acknowledges the batch. HTTP failures, transport errors, malformed acknowledgements, partial rejection of data points and the configured deadline reject the promise. A receiver warning with zero rejected data points succeeds. Pull-only instances reject a strict flush. A timeout can occur after the receiver has received data, and an acknowledgement does not guarantee durable storage downstream.

An optional `otlp.onExportError` receives one event per failed attempt with source `periodic`, `flush` or `shutdown`. The callback can return a promise. Callers sharing a batch receive the same outcome. An arriving flush during an active export queues a fresh collection. The timeout includes queue time. Failures leave readiness under the control of registered checks. Legacy `flush()` and the final shutdown export remain best effort.

## Lifecycle and verification

`health()` returns readiness. `health("liveness")` returns liveness. `metrics()` returns the same text as a scrape. `drain()` immediately makes readiness fail. Call it before closing the application listener. Then await `shutdown()` to finish exporter teardown. Repeated shutdown calls share the same promise. `flush()` asks the SDK to export immediately. Its completion alone does not acknowledge durable storage at a backend.

`make verify` runs lint, strict TypeScript checks, Node and Bun tests, coverage and clean-install end-to-end tests. Those install the packed tarball with Bun and with npm, then send metrics through a real Collector using both OTLP push and Prometheus scrape. The verification harness fetches a checksum-pinned Collector on Linux and macOS. Set `OTELCOL_BIN` to use an installed binary. The host examples in `examples/backplane` and `examples/serve` and the release comparison in `benchmarks` are Bun workspaces that run against this checkout's build. `make bench` measures recording and scrape costs on both runtimes. See [ARCH.md](ARCH.md) for the upstream review and transport boundaries.
