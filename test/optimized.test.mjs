import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createO11y } from "../dist/index.js";

function instance(t, options = {}) {
  const o = createO11y({ serviceName: "optimized", ...options });
  t.after(() => o.shutdown());
  return o;
}
const rows = (body, name) => body.split("\n").filter(line => line.startsWith(name + "{"));
const value = line => Number(line.split(" ").at(-1));
const total = lines => lines.reduce((n, line) => n + value(line), 0);
const isOverflow = line => line.includes('otel_metric_overflow="true"');

test("bounded synchronous series keep cumulative totals across collection intervals", async t => {
  const o = instance(t, { maxSeriesPerInstrument: 2, seriesLimits: { elapsed: 3 } });
  for (let i = 0; i < 1000; i++) {
    const attrs = { worker: i };
    o.sink.incrementCounter("jobs", 2, attrs);
    o.sink.recordHistogram("elapsed", 4, attrs);
    o.sink.setGauge("active", i, attrs);
    if (i % 100 === 0) await o.metrics();
  }
  o.sink.incrementCounter("jobs", 1, { worker: 0 });
  const body = await o.metrics();
  const jobs = rows(body, "jobs_total"), counts = rows(body, "elapsed_count"), sums = rows(body, "elapsed_sum");
  assert.equal(jobs.length, 3);
  assert.equal(total(jobs), 2001);
  assert.equal(value(jobs.find(isOverflow)), 1996);
  assert.equal(value(jobs.find(line => line.includes('worker="0"'))), 3);
  assert.equal(counts.length, 4);
  assert.equal(total(counts), 1000);
  assert.equal(total(sums), 4000);
  assert.equal(value(counts.find(isOverflow)), 997);
  assert.equal(value(sums.find(isOverflow)), 3988);
  const buckets = rows(body, "elapsed_bucket").filter(isOverflow);
  assert.equal(value(buckets.find(line => line.includes('le="0"'))), 0);
  assert.equal(value(buckets.find(line => line.includes('le="+Inf"'))), 997);
  const active = rows(body, "active");
  assert.equal(active.length, 3);
  assert.equal(value(active.find(isOverflow)), 999);
});

test("service budgets precede SDK aggregation across bursts and overflow-first intervals", async t => {
  const n = 2100;
  const o = instance(t, { maxSeriesPerInstrument: 1, seriesLimits: { burst: n } });
  for (let worker = 0; worker <= n; worker++) o.sink.incrementCounter("burst", 1, { worker });
  await o.metrics();
  for (let worker = n; worker >= 0; worker--) o.sink.incrementCounter("burst", 2, { worker });
  const points = rows(await o.metrics(), "burst_total");
  assert.equal(points.length, n + 1);
  assert.equal(total(points), (n + 1) * 3);
  assert.ok(points.every(line => value(line) === 3));
});

test("bound handles share budgets, copy labels and reject invalid or closed writes", async t => {
  const o = instance(t, { maxSeriesPerInstrument: 1 });
  const attrs = { region: "eu", status: 200 };
  const add = o.bindCounter("jobs", attrs);
  assert.equal(rows(await o.metrics(), "jobs_total").length, 0);
  attrs.status = 404;
  const spill = o.bindCounter("jobs", attrs);
  add(); add(3); spill(2);
  o.sink.incrementCounter("jobs", 1, { status: 200, region: "eu", unused: undefined });
  const record = o.bindHistogram("duration"), set = o.bindGauge("load");
  record(4); set(-2);
  const body = await o.metrics(), jobs = rows(body, "jobs_total");
  assert.equal(jobs.length, 2);
  assert.equal(value(jobs.find(isOverflow)), 2);
  assert.equal(value(jobs.find(line => !isOverflow(line))), 5);
  assert.equal(total(rows(body, "duration_sum")), 4);
  assert.equal(total(rows(body, "load")), -2);
  assert.throws(() => add(-1)); assert.throws(() => record(Infinity)); assert.throws(() => set(NaN));
  assert.throws(() => o.bindHistogram("jobs"));
  await o.shutdown();
  for (const handle of [add, spill, record, set]) assert.throws(() => handle(1), /closed/);
});

test("label type conflicts reject one write atomically, even after saturation", async t => {
  const o = instance(t, { maxSeriesPerInstrument: 1 });
  const write = attrs => o.sink.incrementCounter("jobs", 1, attrs);
  assert.throws(() => o.sink.setGauge("jobs", 1, { invalid: NaN }));
  write({ id: 1 });
  assert.throws(() => write({ trial: true, id: "1" }), /requires number/);
  write({ trial: 17 });
  assert.throws(() => write({ trial: false }), /requires number/);
  for (const attrs of [{ otel_metric_overflow: true }, { "otel.metric.overflow": true }, { bad: {} }]) {
    assert.throws(() => write(attrs));
  }
  o.sink.setGauge("separate", 1, { id: "1" });
  for (let i = 0; i < 126; i++) write({ ["k" + i]: true });
  assert.throws(() => write({ oneTooMany: true }), /128 label keys/);
  assert.equal(total(rows(await o.metrics(), "jobs_total")), 128);
});

test("observer budgets apply per snapshot and commit label types only on success", async t => {
  const o = instance(t, { maxSeriesPerInstrument: 1, seriesLimits: { queues: 2 } });
  const point = (v, attrs) => ({ value: v, attributes: attrs });
  let snapshot = [point(1, { id: 1 }), point(2, { id: "1" })];
  o.observe("queues", () => snapshot);
  for (const [next, expected] of [
    [snapshot, 0], [[point(1, { id: "a" }), point(2, { id: "b" })], 2],
    [[point(1, { id: "a" }), point(2, { id: "b" }), point(3, { id: "c" })], 0],
    [[point(1, { id: true })], 0], [[point(1, { id: "c" })], 1], [[], 0],
  ]) {
    snapshot = next;
    const body = await o.metrics();
    assert.equal(rows(body, "queues").length, expected);
    assert.equal(total(rows(body, "defuss_o11y_observer_success")), Number(expected > 0 || next.length === 0));
  }
});

test("positive check TTL spans health and metrics, expires, retries failures and respects removal", async t => {
  const o = instance(t);
  let pass = true, calls = 0, uncached = 0;
  const remove = o.check("remote", () => { calls++; return pass; }, { probe: "liveness", maxAgeMs: 90 });
  o.check("local", () => { uncached++; return true; });
  await Promise.all([o.health(), o.metrics()]);
  pass = false;
  await o.health("liveness"); await o.health(); await o.metrics();
  assert.equal(calls, 1); assert.ok(uncached >= 3);
  await delay(100);
  assert.equal((await o.health()).status, "fail");
  assert.equal((await o.health()).status, "fail");
  assert.equal(calls, 3);
  pass = true;
  assert.equal((await o.health()).status, "pass");
  assert.equal(calls, 4);
  remove();
  o.check("remote", () => false, { maxAgeMs: 90 });
  assert.equal((await o.health()).status, "fail");
});

test("drain overrides cached success and an in-flight readiness result", async t => {
  const o = instance(t);
  o.check("warm", () => true, { maxAgeMs: 10000 });
  await o.health();
  const began = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  o.check("remote", () => { calls++; began.resolve(); return release.promise; });
  const pending = o.health();
  await began.promise;
  o.drain();
  assert.deepEqual((await o.health()).checks, []);
  assert.equal((await o.health("liveness")).status, "pass");
  release.resolve(true);
  assert.equal((await pending).status, "fail");
  assert.equal(calls, 1);
});

test("an aborted callback cannot seed the positive cache or observer schema", async t => {
  const o = instance(t, { timeoutMs: 25 });
  const late = Promise.withResolvers();
  let calls = 0, snapshots = 0;
  o.check("slow", () => ++calls === 1 ? late.promise : false, { maxAgeMs: 10000 });
  o.observe("queue", async () => ++snapshots === 1
    ? [{ value: 1, attributes: { id: await late.promise } }] : [{ value: 2, attributes: { id: "valid" } }]);
  const failed = await o.metrics();
  assert.equal(total(rows(failed, "defuss_o11y_ready")), 0);
  assert.equal(rows(failed, "queue").length, 0);
  late.resolve(true);
  await delay(0);
  const body = await o.metrics();
  assert.equal(calls, 2);
  assert.equal(total(rows(body, "defuss_o11y_ready")), 0);
  assert.equal(total(rows(body, "queue")), 2);
});

test("invalid budgets, TTLs and exporter-owned names are rejected", t => {
  for (const n of [0, -1, 1.2, Infinity, 2**31]) {
    for (const cfg of [{ maxSeriesPerInstrument: n }, { seriesLimits: { x: n } }]) {
      assert.throws(() => createO11y({ serviceName: "invalid", ...cfg }), /series limit/);
    }
  }
  for (const seriesLimits of [null, "256", []]) assert.throws(() => createO11y({ serviceName: "invalid", seriesLimits }));
  const o = instance(t);
  for (const n of [-1, 0.5, Infinity, 2**31]) assert.throws(() => o.check("ttl", () => true, { maxAgeMs: n }));
  o.sink.incrementCounter("A_TOTAL");
  assert.throws(() => o.sink.setGauge("a_total_total", 1));
});
