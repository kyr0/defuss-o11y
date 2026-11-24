import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createO11y } from "../dist/index.js";

function service(t, config = {}) {
  const obs = createO11y({ serviceName: "v03", ...config });
  t.after(() => obs.shutdown());
  return obs;
}
const samples = (text, name) => text.split("\n").filter(s => s.startsWith(name + "{"));
const number = line => Number(line.split(" ").at(-1));

test("empty and absent dimensions share one admitted counter, gauge, and histogram identity", async t => {
  const obs = service(t, { maxSeriesPerInstrument: 1 });
  const a = { tenant: "", agent: undefined };
  obs.bindCounter("jobs", a)(2);
  obs.sink.incrementCounter("jobs", 3);
  for (const [value, attrs] of [[8, {}], [3, a]]) {
    obs.sink.setGauge("workers", value, attrs);
    obs.sink.recordHistogram("duration", value, attrs);
  }
  const body = await obs.metrics();
  for (const [name, n] of [["jobs_total", 5], ["workers", 3], ["duration_sum", 11], ["duration_count", 2]]) {
    const rows = samples(body, name);
    assert.deepEqual(rows.map(number), [n]);
    assert.doesNotMatch(rows[0], /tenant=|agent=|otel_metric_overflow/);
  }
});

test("observers reject duplicate normalized series and roll back all schema additions", async t => {
  const obs = service(t);
  let snapshot = [{ value: 7, attributes: { "http.route": "x" } }, { value: 9, attributes: { "http.route": "x", queue: "" } }];
  obs.observe("depth", () => snapshot);
  const failed = await obs.metrics();
  assert.deepEqual(samples(failed, "depth"), []);
  assert.equal(number(samples(failed, "defuss_o11y_observer_success")[0]), 0);
  snapshot = [{ value: 9, attributes: { http_route: false, shard: 0 } }];
  assert.match(samples(await obs.metrics(), "depth")[0], /http_route="false",shard="0"/);
  snapshot = [{ value: 1, attributes: { "http.route": "x" } }];
  assert.deepEqual(samples(await obs.metrics(), "depth"), []);
});

test("raw OTLP keys have one Prometheus spelling per instrument, including overflow", async t => {
  const obs = service(t, { maxSeriesPerInstrument: 1 });
  obs.sink.incrementCounter("jobs", 1, { "http.route": "ok" });
  assert.throws(() => obs.bindCounter("jobs", { extra: 2, http_route: "other" }), /collision/);
  obs.sink.incrementCounter("jobs", 1, { extra: true });
  for (const key of ["otel.metric.overflow", "otel.scope.name", "otel.scope_version", "a..b", "a__b"]) {
    assert.throws(() => obs.sink.incrementCounter("jobs", 1, { [key]: 2 }));
  }
  assert.throws(() => obs.sink.setGauge("fresh", 4, { "a.b": 1, a_b: 1 }), /collision/);
  obs.sink.setGauge("fresh", 4, { a_b: false });
  assert.equal(number(samples(await obs.metrics(), "fresh")[0]), 4);
});

test("declared histograms snapshot their configuration, preserving per-bucket resolution", async t => {
  const obs = service(t, { maxSeriesPerInstrument: 1 });
  const bounds = [0.01, 0.1, 1];
  obs.defineHistogram("request_duration_seconds", { unit: "s", description: "HTTP latency", explicitBucketBoundaries: bounds });
  bounds[0] = 0.001;
  assert.deepEqual(samples(await obs.metrics(), "request_duration_seconds_count"), []);
  const attrs = { "http.request.method": "GET" };
  const record = obs.bindHistogram("request_duration_seconds", attrs);
  record(0.008); record(0.08); obs.sink.recordHistogram("request_duration_seconds", 0.8, attrs);
  const text = await obs.metrics();
  assert.match(text, /# HELP request_duration_seconds HTTP latency/);
  assert.match(text, /# UNIT request_duration_seconds s/);
  assert.deepEqual(samples(text, "request_duration_seconds_bucket").map(number), [1, 2, 3, 3]);
  assert.throws(() => obs.defineHistogram("request_duration_seconds"));
  assert.throws(() => obs.sink.incrementCounter("request_duration_seconds_count"));
  for (const opts of [{ unit: "bad unit" }, { description: 42 }, ...[[1, 1], [2, 1], [NaN], [Infinity], Array(1), "0"].map(explicitBucketBoundaries => ({ explicitBucketBoundaries }))]) {
    assert.throws(() => obs.defineHistogram("retry", opts));
  }
  obs.defineHistogram("retry", { explicitBucketBoundaries: [] });
  obs.sink.recordHistogram("retry", 1);
  assert.deepEqual(samples(await obs.metrics(), "retry_bucket").map(number), [1]);
});

test("Fetch fallthrough preserves the host request, shared method handling and standalone 404", async t => {
  const obs = service(t);
  const unknown = new Request("http://host/rpc", { method: "POST", body: "rpc" });
  assert.equal(obs.matches(unknown), false); assert.equal(await obs.handle(unknown), undefined);
  assert.equal(await unknown.text(), "rpc");
  assert.equal((await obs.fetch(new Request("http://host/missing"))).status, 404);
  for (const path of ["/readyz", "/livez", "/health", "/healthz", "/metrics"]) {
    const post = new Request("http://host" + path + "?x=1", { method: "POST" });
    assert.equal(obs.matches(post), true);
    assert.equal((await obs.handle(post)).status, 405);
    const head = await obs.handle(new Request(post.url, { method: "HEAD" }));
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  }
});

async function receiver(t, options = {}) {
  let reply = (_req, res) => res.end("{}");
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("content-type", "application/json");
    reply(JSON.parse(Buffer.concat(chunks).toString()), res);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const events = [];
  const obs = createO11y({ serviceName: "push-review", timeoutMs: 10, otlp: {
    endpoint: "http://127.0.0.1:" + server.address().port + "/v1/metrics", timeoutMs: 500, intervalMs: 60000,
    onExportError: event => { events.push(event); }, ...options,
  } });
  t.after(async () => {
    reply = (_req, res) => res.end("{}");
    try { await obs.shutdown(); } finally { await new Promise(resolve => server.close(resolve)); }
  });
  return { obs, events, respond: fn => { reply = fn; } };
}

test("strict flush reports HTTP, partial and malformed responses and recovers on the next batch", async t => {
  const { obs, respond, events } = await receiver(t);
  const flush = () => obs.flush({ strict: true });
  await flush();
  respond((_r, res) => res.writeHead(400).end("{}"));
  await assert.rejects(flush(), e => e.code === 400);
  await obs.flush(); // legacy completion, still observable through the hook.
  respond((_r, res) => res.end('{"partialSuccess":{"rejectedDataPoints":"2"}}'));
  await assert.rejects(flush(), /rejected 2 data points/);
  respond((_r, res) => res.end("invalid JSON"));
  await assert.rejects(flush());
  respond((_r, res) => res.end('{"partialSuccess":{"rejectedDataPoints":"0","errorMessage":"warning"}}'));
  await flush();
  assert.equal((await obs.health()).status, "pass");
  assert.deepEqual(events.map(e => e.source), Array(4).fill("flush"));
  const pullOnly = service(t);
  await pullOnly.flush();
  await assert.rejects(pullOnly.flush({ strict: true }), /requires OTLP/);
});

test("strict flush deadline leaves the exporter usable and reports once", async t => {
  const { obs, events, respond } = await receiver(t, { timeoutMs: 80 });
  respond(() => {});
  await assert.rejects(obs.flush({ strict: true }), /timed? ?out|timeout/i);
  respond((_r, res) => res.end("{}"));
  await obs.flush({ strict: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "flush");
});

test("periodic failures are instance-local and a failing hook leaves readiness healthy", async t => {
  const event = Promise.withResolvers();
  const { obs, respond } = await receiver(t, { intervalMs: 100, timeoutMs: 80,
    onExportError: async e => { event.resolve(e); throw new Error("hook failed"); } });
  respond((_r, res) => res.writeHead(400).end("{}"));
  const healthy = await receiver(t);
  await healthy.obs.flush({ strict: true });
  const result = await event.promise;
  assert.equal(result.source, "periodic"); assert.equal(result.error.code, 400);
  assert.equal(healthy.events.length, 0);
  assert.equal((await obs.health()).status, "pass");
  respond((_r, res) => res.end("{}"));
  await obs.flush({ strict: true });
});

test("overlapping strict flushes observe the batch after the last write, including after a failure", async t => {
  const { obs, respond } = await receiver(t);
  const entered = Promise.withResolvers(); const values = [];
  respond((batch, res) => {
    const work = batch.resourceMetrics[0].scopeMetrics.flatMap(s => s.metrics).find(m => m.name === "jobs");
    values.push(Number(work.sum.dataPoints[0].asDouble ?? work.sum.dataPoints[0].asInt));
    if (values.length === 1) entered.resolve(res);
    else res.end("{}");
  });
  obs.sink.incrementCounter("jobs", 1);
  const first = obs.flush({ strict: true });
  const res = await entered.promise;
  obs.sink.incrementCounter("jobs", 2);
  const later = Promise.all([obs.flush({ strict: true }), obs.flush({ strict: true })]);
  res.writeHead(400).end("{}");
  await assert.rejects(first, e => e.code === 400);
  await later;
  assert.deepEqual(values, [1, 3]);
});

test("shutdown reports a rejected final batch and clears its periodic timer", async t => {
  const { obs, events, respond } = await receiver(t, { intervalMs: 120, timeoutMs: 80 });
  let sends = 0;
  respond((_r, res) => { sends++; res.writeHead(400).end("{}"); });
  await obs.shutdown();
  await delay(135);
  assert.equal(sends, 1); assert.deepEqual(events.map(e => e.source), ["shutdown"]);
  await assert.rejects(obs.flush({ strict: true }), /closed/);
});
