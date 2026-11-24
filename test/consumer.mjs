// Runs from a clean directory with the packed tarball installed.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { createO11y } from "defuss-o11y";

const [binary, evidenceFile] = process.argv.slice(2);
const runtime = process.versions.bun ? "bun" : "node";
const dir = await mkdtemp(join(tmpdir(), "o11y-wire-"));
const tempServer = createServer();
tempServer.listen(0, "127.0.0.1");
await once(tempServer, "listening");
const collectorPort = tempServer.address().port;
await new Promise(resolve => tempServer.close(resolve));
const otlp = "http://127.0.0.1:" + collectorPort + "/v1/metrics";

const obs = createO11y({ serviceName: "e2e-" + runtime, instanceId: runtime,
  seriesLimits: { limited_jobs: 2, limited_duration: 2 },
  timeoutMs: 250, otlp: { endpoint: otlp, intervalMs: 1500, timeoutMs: 1000 } });
obs.check("queue", async () => true);
obs.observe("queue_depth", async () => [{ value: 37, attributes: { pool: "io" } }]);
obs.sink.incrementCounter("joined", 2);
obs.bindCounter("joined", { queue: "" })(3);
obs.observe("duplicate_depth", () => [{ value: 1 }, { value: 2, attributes: { queue: "" } }]);
obs.defineHistogram("http.server.request.duration", {
  description: "Observed HTTP latency", unit: "s", explicitBucketBoundaries: [0.01, 0.1, 1],
});
const duration = obs.bindHistogram("http.server.request.duration", { "http.request.method": "GET" });
for (const sample of [0.008, 0.08, 0.8]) duration(sample);
obs.sink.incrementCounter("jobs", 3);
obs.sink.recordHistogram("duration", 8);
obs.sink.setGauge("active", 5, { zone: "a" });
obs.sink.setGauge("active", 7, { zone: "b" });

for (const [label, delta] of [["a", 1], ["b", 2], ["c", 3], ["d", 4], ["a", 5]]) {
  obs.sink.incrementCounter("limited_jobs", delta, { label });
  obs.sink.recordHistogram("limited_duration", delta, { label });
}

let close, port, collector, logs = "";
try {
  if (runtime === "bun") {
    const server = globalThis.Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => await obs.handle(req) ?? new Response("host", { status: 404 }) });
    close = () => server.stop(true);
    port = server.port;
  } else {
    const app = express();
    app.use(obs.middleware);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    close = () => new Promise(resolve => server.close(resolve));
    port = server.address().port;
  }

  const config = {
    receivers: {
      otlp: { protocols: { http: { endpoint: "127.0.0.1:" + collectorPort } } },
      prometheus: { config: { scrape_configs: [{ job_name: "e2e", scrape_interval: "1s",
        static_configs: [{ targets: ["127.0.0.1:" + port] }] }] } },
    },
    exporters: {
      "file/push": { path: join(dir, "push.jsonl"), flush_interval: "100ms" },
      "file/pull": { path: join(dir, "pull.jsonl"), flush_interval: "100ms" },
    },
    service: { telemetry: { metrics: { level: "none" } }, pipelines: {
      "metrics/push": { receivers: ["otlp"], exporters: ["file/push"] },
      "metrics/pull": { receivers: ["prometheus"], exporters: ["file/pull"] },
    } },
  };
  const configFile = join(dir, "collector.yaml");
  await writeFile(configFile, JSON.stringify(config));
  collector = spawn(binary, ["--config=" + configFile], { stdio: ["ignore", "pipe", "pipe"] });
  const collectLog = chunk => { logs = (logs + chunk).slice(-8192); };
  collector.stderr.on("data", collectLog);
  collector.stdout.on("data", collectLog);

  async function until(fn) {
    const end = Date.now() + 12000;
    do {
      if (collector.exitCode !== null) throw new Error("Collector exited: " + logs);
      const result = await fn();
      if (result) return result;
      await delay(80);
    } while (Date.now() < end);
    throw new Error("Collector observation timed out: " + logs);
  }
  await until(async () => {
    try {
      const response = await fetch(otlp, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return response.ok;
    } catch { return false; }
  });
  const routes = {};
  for (const path of ["/health", "/healthz", "/readyz", "/livez", "/metrics"]) {
    const r = await fetch("http://127.0.0.1:" + port + path);
    assert.equal(r.status, 200);
    routes[path] = r.status;
    if (path === "/metrics") assert.match(await r.text(), /queue_depth\{pool="io".*\} 37/);
    else assert.equal((await r.json()).status, "pass");
  }

  async function payload(pipeline) {
    const file = join(dir, pipeline + ".jsonl");
    return until(async () => {
      if (!existsSync(file)) return undefined;
      const lines = (await readFile(file, "utf8")).split("\n").slice(0, -1);
      for (const line of lines) {
        const records = JSON.parse(line).resourceMetrics ?? [];
        for (const resource of records) {
          const metrics = resource.scopeMetrics.flatMap(s => s.metrics);
          const names = metrics.map(m => m.name);
          const q = metrics.find(m => m.name === "queue_depth");
          if (!q) continue;
          assert.equal(Number(q.gauge.dataPoints[0].asDouble ?? q.gauge.dataPoints[0].asInt), 37);
          assert.ok(q.gauge.dataPoints[0].attributes.some(a => a.key === "pool" && a.value.stringValue === "io"));
          return { names, resource, metrics };
        }
      }
    });
  }
  const push = await payload("push"), pull = await payload("pull");
  await obs.flush({ strict: true });
  const find = name => push.metrics.find(m => m.name === name);
  const numeric = p => Number(p.asDouble ?? p.asInt);
  assert.ok(push.resource.resource.attributes.some(a => a.key === "service.name" && a.value.stringValue === "e2e-" + runtime));
  assert.equal(numeric(find("jobs").sum.dataPoints[0]), 3);
  assert.equal(Number(find("duration").histogram.dataPoints[0].count), 1);
  assert.deepEqual(find("active").gauge.dataPoints.map(numeric).sort(), [5, 7]);
  assert.equal(numeric(find("defuss_o11y_ready").gauge.dataPoints[0]), 1);
  function verifyOverflow(batch) {
    const counter = batch.metrics.find(m => ["limited_jobs", "limited_jobs_total"].includes(m.name));
    const histogram = batch.metrics.find(m => m.name === "limited_duration");
    function byLabel(points, pick) {
      return Object.fromEntries(points.map(p => {
        const dim = p.attributes.find(a => a.key === "label");
        if (!dim) assert.ok(p.attributes.some(a => ["otel.metric.overflow", "otel_metric_overflow"].includes(a.key)
          && (a.value.boolValue === true || a.value.stringValue === "true")));
        return [dim?.value.stringValue ?? "overflow", pick(p)];
      }));
    }
    assert.equal(counter.sum.isMonotonic, true);
    const sums = counter.sum.dataPoints, buckets = histogram.histogram.dataPoints;
    assert.equal(sums.length, 3);
    assert.equal(buckets.length, 3);
    const counts = byLabel(sums, numeric);
    const hist = byLabel(buckets, p => ({ count: Number(p.count), sum: Number(p.sum) }));
    assert.deepEqual(counts, { a: 6, b: 2, overflow: 7 });
    assert.deepEqual(hist, { a: { count: 2, sum: 6 }, b: { count: 1, sum: 2 }, overflow: { count: 2, sum: 7 } });
    return { counter: counts, histogram: hist };
  }
  const overflow = { push: verifyOverflow(push), pull: verifyOverflow(pull) };
  function verifyIdentityAndLatency(batch, pushed) {
    const jobs = batch.metrics.find(m => ["joined_total", "joined"].includes(m.name)).sum.dataPoints;
    assert.equal(jobs.length, 1);
    assert.equal(numeric(jobs[0]), 5);
    assert.ok(!jobs[0].attributes?.some(a => a.key === "queue"));
    assert.ok(!batch.names.includes("duplicate_depth"));
    const validity = batch.metrics.find(m => m.name === "defuss_o11y_observer_success").gauge.dataPoints;
    assert.equal(numeric(validity.find(p => p.attributes.some(a => a.key === "observer" && a.value.stringValue === "duplicate_depth"))), 0);
    const latency = batch.metrics.find(m => /http[._]server[._]request[._]duration/.test(m.name));
    assert.equal(latency.histogram.dataPoints.length, 1);
    const point = latency.histogram.dataPoints[0];
    assert.equal(Number(point.count), 3);
    assert.deepEqual(point.explicitBounds, [0.01, 0.1, 1]);
    assert.deepEqual(point.bucketCounts.map(Number), [1, 1, 1, 0]);
    assert.ok(Math.abs(Number(point.sum) - 0.888) < 1e-12);
    const label = pushed ? "http.request.method" : "http_request_method";
    assert.ok(point.attributes.some(a => a.key === label && a.value.stringValue === "GET"));
    if (pushed) { assert.equal(latency.unit, "s"); assert.equal(latency.description, "Observed HTTP latency"); }
    return { counter: 5, counterSeries: 1, duplicateObserverSuccess: 0, label, boundaries: point.explicitBounds,
      bucketCounts: point.bucketCounts.map(Number), unit: latency.unit ?? "", description: latency.description ?? "" };
  }
  const interoperability = { push: verifyIdentityAndLatency(push, true), pull: verifyIdentityAndLatency(pull, false) };
  const responses = [[400, "{}"], [200, '{"partialSuccess":{"rejectedDataPoints":"1"}}'], [200, "{}"]];
  let attempt = 0;
  const fixture = httpServer((req, res) => {
    req.resume();
    const [code, body] = responses[Math.min(attempt++, responses.length - 1)];
    res.writeHead(code, { "content-type": "application/json" }).end(body);
  });
  fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
  const failureSources = [];
  const other = createO11y({ serviceName: "flush-wire", timeoutMs: 20, otlp: {
    endpoint: "http://127.0.0.1:" + fixture.address().port + "/v1/metrics",
    timeoutMs: 1000, onExportError: f => { failureSources.push(f.source); },
  } });
  try {
    await assert.rejects(other.flush({ strict: true }), e => e.code === 400);
    await assert.rejects(other.flush({ strict: true }), /rejected 1 data points/);
    await other.flush({ strict: true });
    assert.deepEqual(failureSources, ["flush", "flush"]);
    assert.equal(attempt, 3);
    assert.equal((await other.health()).status, "pass");
  } finally { try { await other.shutdown(); } finally { await new Promise(resolve => fixture.close(resolve)); } }
  const evidence = { testedAt: new Date().toISOString(), runtime, version: process.versions.bun ?? process.versions.node,
    collector: execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(), routes, overflow, interoperability, strictFlush: ["HTTP 400 rejected", "partial rejection reported", "success after recovery"],
    push: push.names, pull: pull.names, queueDepth: 37 };
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
  console.log(runtime, "clean tarball, 5 routes, Collector push and scrape passed");
} finally {
  try { await obs.shutdown(); } finally {
    try { await close?.(); } finally {
      if (collector && collector.exitCode === null && collector.signalCode === null) {
        const stopped = once(collector, "exit"); collector.kill("SIGTERM"); await stopped;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
}
