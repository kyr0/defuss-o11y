import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { createO11y } from "../dist/index.js";

function service(t, config = {}) {
  const obs = createO11y({ serviceName: "unit", ...config });
  t.after(() => obs.shutdown());
  return obs;
}
const rows = (text, name) => text.split("\n").filter(line => line.startsWith(name + "{"));

test("readiness includes live checks and hides exception contents", async t => {
  const o = service(t);
  const remove = o.check("db", async () => { throw Error("private connection string"); });
  o.check("worker", () => true, "liveness");
  assert.equal((await o.health("liveness")).status, "pass");
  assert.deepEqual(await o.health(), { service: "unit", status: "fail", checks: [
    { name: "db", status: "fail", reason: "error" }, { name: "worker", status: "pass" },
  ] });
  remove();
  o.check("db", () => false);
  remove(); // Previous disposer cannot remove its replacement.
  assert.equal((await o.health()).status, "fail");
  assert.throws(() => o.check("missing", undefined));
  assert.throws(() => o.check("worker", () => true));
  assert.throws(() => o.check("bad name", () => true));
  assert.throws(() => o.check("x", () => true, "invalid"));
  await assert.rejects(o.health("invalid"));
});

test("drain affects readiness and its metric, and shutdown is idempotent", async t => {
  const o = service(t);
  o.drain();
  assert.equal((await o.health()).status, "fail");
  assert.equal((await o.health("liveness")).status, "pass");
  assert.match((await o.metrics()), /defuss_o11y_ready\{[^\n]*\} 0/);
  const close = o.shutdown();
  assert.equal(close, o.shutdown());
  assert.throws(() => o.sink.setGauge("pending", 1));
  await close;
  assert.equal((await o.health("liveness")).status, "fail");
  await assert.rejects(o.flush());
  assert.equal((await o.fetch(new Request("http://service/metrics"))).status, 503);
});

test("callback deadlines, coalescing and recovery after ignored cancellation", async t => {
  const o = service(t, { timeoutMs: 30 });
  let calls = 0, abortSignal, release;
  o.check("slow", signal => {
    calls++;
    abortSignal = signal;
    return calls === 1 ? new Promise(resolve => { release = resolve; }) : true;
  });
  const reports = await Promise.all([o.health(), o.health(), o.metrics()]);
  assert.equal(calls, 1);
  assert.equal(abortSignal.aborted, true);
  assert.equal(reports[0].checks[0].reason, "timeout");
  assert.equal((await o.health()).status, "fail");
  assert.equal(calls, 1);
  assert.match(reports[2], /defuss_o11y_check_success\{check="slow"[^\n]*\} 0/);
  release(true);
  await delay(0);
  assert.equal((await o.health()).status, "pass");
  assert.equal(calls, 2);
});

test("removal aborts a pending check and withdraws its metric", async t => {
  const o = service(t);
  const stop = o.check("db", () => true);
  assert.equal(rows(await o.metrics(), "defuss_o11y_check_success").length, 1);
  stop();
  assert.equal(rows(await o.metrics(), "defuss_o11y_check_success").length, 0);
  const started = Promise.withResolvers();
  const remove = o.check("pending", signal => { started.resolve(signal); return once(signal, "abort").then(() => false); });
  const report = o.health();
  const signal = await started.promise;
  remove();
  assert.equal(signal.aborted, true);
  assert.equal((await report).checks[0].reason, "closed");
});

test("counter, histogram and labeled gauge use independent time series", async t => {
  const o = service(t);
  o.sink.incrementCounter("jobs", 2, { kind: "read" });
  o.sink.incrementCounter("jobs", undefined, { kind: "read" });
  o.sink.recordHistogram("latency", 11);
  o.sink.recordHistogram("latency", 9);
  o.sink.setGauge("queue.depth", 1, { queue: "a" });
  o.sink.setGauge("queue.depth", 8, { queue: "b" });
  o.sink.setGauge("queue.depth", 5, { queue: "a" });
  for (let i = 0; i < 2; i++) {
    const text = await o.metrics();
    assert.match(text, /jobs_total\{kind="read".*\} 3\n/);
    assert.match(text, /latency_count\{.*\} 2\n/);
    assert.match(text, /latency_sum\{.*\} 20\n/);
    assert.match(text, /queue_depth\{queue="a".*\} 5\n/);
    assert.match(text, /queue_depth\{queue="b".*\} 8\n/);
  }
  assert.throws(() => o.observe("queue_depth", () => 1));
  assert.throws(() => o.sink.setGauge("jobs_total", 1));
  assert.throws(() => o.sink.setGauge("latency_bucket", 1));
  assert.throws(() => o.sink.incrementCounter("jobs", -1));
  assert.throws(() => o.sink.setGauge("NaN", NaN));
  assert.throws(() => o.sink.recordHistogram("ms", -1));
  assert.throws(() => o.sink.setGauge("bad", 1, { "a..b": 3 }));
  assert.throws(() => o.sink.setGauge("bad", 1, { size: Infinity }));
});

test("observer failures and shrinking series never replay a stale value", async t => {
  const o = service(t);
  let result = [{ value: 2, attributes: { pool: "a" } }, { value: -3, attributes: { pool: "b" } }];
  let calls = 0;
  o.observe("workers", async () => { calls++; return result; });
  assert.throws(() => o.observe("healthy_observer", null));
  for (const options of [{ unit: "two lines\n" }, { description: 42 }, { description: null }, null]) {
    assert.throws(() => o.observe("healthy_observer", () => 1, options));
  }
  // A rejected registration leaves the name free and the scrape intact.
  o.observe("healthy_observer", () => 17, { unit: "By" });
  const first = await Promise.all([o.metrics(), o.metrics()]);
  assert.equal(calls, 1);
  assert.equal(rows(first[0], "workers").length, 2);
  result = result.slice(1);
  assert.equal(rows(await o.metrics(), "workers").length, 1);
  for (const invalid of [NaN, null, Array(2), [{ value: 1 }, { value: 2 }]]) {
    result = invalid;
    const text = await o.metrics();
    assert.equal(rows(text, "workers").length, 0);
    assert.match(text, /defuss_o11y_observer_success\{observer="workers".*\} 0/);
    assert.match(text, /healthy_observer\{.*\} 17/);
  }
});

test("Express mount shares health, HEAD, method and fallthrough semantics", async t => {
  const o = service(t);
  const app = express();
  app.use("/ops", o.middleware);
  app.use((_req, res) => res.status(404).send("from host"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const base = "http://127.0.0.1:" + server.address().port + "/ops";
  o.check("db", () => false);
  for (const path of ["/health", "/readyz"]) {
    const r = await fetch(base + path + "?full=1");
    assert.equal(r.status, 503);
    assert.equal((await r.json()).checks[0].status, "fail");
  }
  for (const path of ["/healthz", "/livez"]) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  const head = await fetch(base + "/metrics", { method: "HEAD" });
  assert.equal(await head.text(), "");
  assert.match(head.headers.get("content-type"), /version=0.0.4/);
  const post = await fetch(base + "/health", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  assert.equal(await (await fetch(base + "/missing")).text(), "from host");
  assert.equal((await o.fetch(new Request("http://svc/missing"))).status, 404);
});

test("configuration rejects invalid timer and transport values", () => {
  for (const options of [{ serviceName: " " }, { timeoutMs: 0 }, { timeoutMs: 2**31 },
    { otlp: { endpoint: "file:///dev/null" } }, { otlp: { intervalMs: 2, timeoutMs: 3 } },
    { otlp: { endpoint: "https://test/#fragment" } }]) {
    assert.throws(() => createO11y({ serviceName: "test", ...options }));
  }
});
