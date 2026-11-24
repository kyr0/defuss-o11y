// Run after make build. Optional positional arguments are the current and baseline ESM entry paths.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const [currentPath, baselinePath] = process.argv.slice(2);
const load = path => import(pathToFileURL(resolve(path)).href);
const current = currentPath ? await load(currentPath) : await import("../dist/index.js");
const baseline = baselinePath ? await load(baselinePath) : undefined;
const opts = { serviceName: "bench", instanceId: "bench" };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const workRows = body => body.split("\n").filter(line => line.startsWith("work_total{"));
const count = line => Number(line.slice(line.lastIndexOf(" ") + 1));

async function records() {
  const dims = Object.freeze({ route: "jobs", method: "GET", status: 200 });
  const instances = [], cases = [];
  function add(name, implementation, bound) {
    const service = implementation.createO11y(opts);
    instances.push(service);
    const write = bound ? service.bindCounter("work", dims) : () => service.sink.incrementCounter("work", 1, dims);
    cases.push({ name, write, service, samples: [] });
  }
  if (baseline) { add("v0.2 dynamic", baseline, false); add("v0.2 bound", baseline, true); }
  add("v0.3 dynamic", current, false);
  add("v0.3 bound", current, true);
  const calls = 60000, blocks = 11;
  try {
    for (let round = 0; round < blocks; round++) {
      for (let i = 0; i < cases.length; i++) {
        const entry = cases[(i + round) % cases.length], write = entry.write;
        const start = performance.now();
        for (let j = 0; j < calls; j++) write();
        if (round >= 2) entry.samples.push((performance.now() - start) * 1000 / calls);
      }
    }
    for (const entry of cases) {
      const rows = workRows(await entry.service.metrics());
      assert.equal(rows.length, 1);
      assert.equal(count(rows[0]), calls * blocks);
    }
    return Object.fromEntries(cases.map(c => [c.name, { medianUs: median(c.samples), samplesUs: c.samples }]));
  } finally { await Promise.all(instances.map(service => service.shutdown())); }
}

async function churn(implementation, normalSeriesLimit, options = {}) {
  const service = implementation.createO11y({ ...opts, ...options });
  let added = 0;
  const results = [];
  try {
    for (const writes of [100, 1000, 3500, 10000]) {
      while (added < writes) {
        const end = Math.min(added + 100, writes);
        for (; added < end; added++) service.sink.incrementCounter("work", 1, { worker: String(added) });
        await service.metrics();
      }
      let text;
      const samples = [];
      for (let i = 0; i < 23; i++) {
        const start = performance.now();
        text = await service.metrics();
        if (i >= 2) samples.push(performance.now() - start);
      }
      const rows = workRows(text), total = rows.reduce((n, line) => n + count(line), 0);
      assert.equal(rows.length, Math.min(writes, normalSeriesLimit + 1));
      assert.equal(total, writes);
      const overflow = rows.find(line => line.includes('otel_metric_overflow="true"'));
      assert.equal(overflow ? count(overflow) : 0, Math.max(0, writes - normalSeriesLimit));
      results.push({ writes, series: rows.length, total, bytes: Buffer.byteLength(text), medianMs: median(samples), samplesMs: samples });
    }
    return results;
  } finally { await service.shutdown(); }
}

const recording = await records();
const growth = {};
if (baseline) {
  growth["v0.2 default"] = await churn(baseline, 2000);
  growth["v0.2 limit 256"] = await churn(baseline, 256, { seriesLimits: { work: 256 } });
}
growth["v0.3 default"] = await churn(current, 2000);
growth["v0.3 limit 256"] = await churn(current, 256, { seriesLimits: { work: 256 } });
console.log(JSON.stringify({
  runtime: process.versions.bun ? "bun" : "node", version: process.versions.bun ?? process.versions.node,
  platform: process.platform, arch: process.arch, recording, growth,
}, null, 2));
