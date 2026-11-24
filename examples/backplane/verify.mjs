import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { connectBackplane } from "defuss-backplane/client";
import { startBackend } from "./server.ts";

const temp = await mkdtemp(join(tmpdir(), "o11y-backplane-"));
const apiKey = randomBytes(24).toString("hex");
const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const runtime = process.versions.bun ? "bun" : "node";
const app = await startBackend({ port: 0, backplanePort: port, apiKey });
const get = path => fetch(app.url + path, { signal: AbortSignal.timeout(15000) });
const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("defuss-backplane")));
const requests = {};
async function measureRequests() {
  const origin = "http://127.0.0.1:" + port;
  const traffic = channel("undici:request:create");
  let counts = {};
  function record({ request }) {
    if (String(request.origin) === origin) counts[request.path] = (counts[request.path] ?? 0) + 1;
  }
  traffic.subscribe(record);
  try {
    await delay(1050);
    const cases = [
      ["expiredReadyThenScrape", ["/readyz", "/metrics"], { "/rpc/schema": 1, "/rpc": 1 }],
      ["warmReadyThenScrape", ["/readyz", "/metrics"], { "/rpc": 1 }],
      ["live", ["/livez"], {}],
    ];
    for (const [name, paths, expected] of cases) {
      counts = {};
      for (const path of paths) {
        const response = await get(path);
        assert.equal(response.status, 200);
        await response.text();
      }
      assert.deepEqual(counts, expected);
      requests[name] = counts;
    }
  } finally { traffic.unsubscribe(record); }
}
let daemon;
async function start() {
  daemon = spawn(process.execPath, [cli], { cwd: temp,
    env: { ...process.env, API_KEY: apiKey, PORT: String(port), BACKPLANE_DATA_DIR: temp },
    stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const append = chunk => { log = (log + chunk).slice(-2048); };
  daemon.stdout.on("data", append);
  daemon.stderr.on("data", append);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("Daemon exited: " + log);
    if (log.includes("INFO listening http://127.0.0.1:" + port)) {
      assert.equal((await get("/readyz")).status, 200);
      return;
    }
    await delay(100);
  }
  throw new Error("Backplane startup timed out: " + log);
}
async function stop() {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  const exited = once(daemon, "exit");
  daemon.kill("SIGTERM");
  const kill = setTimeout(() => daemon.kill("SIGKILL"), 20000);
  try { const [code] = await exited; assert.equal(code, 0); } finally { clearTimeout(kill); }
}
function depth(body) { return body.split("\n").find(line => /^queue_depth(?:\{| )/.test(line)); }
try {
  assert.equal((await get("/health")).status, 503);
  assert.equal((await get("/healthz")).status, 200);
  // Force failed initial schema discovery, then verify the observer retries it.
  assert.equal(depth(await (await get("/metrics")).text()), undefined);
  await start();
  const wrongKey = await startBackend({ port: 0, backplanePort: port, apiKey: apiKey + "x" });
  try {
    assert.equal((await fetch(wrongKey.url + "/health")).status, 503);
    assert.equal((await fetch(wrongKey.url + "/healthz")).status, 200);
  } finally { await wrongKey.close(); }
  const backplane = await connectBackplane({ app: "queue-api", port, apiKey });
  const cache = backplane.tenant("local").cache("metrics");
  assert.equal(depth(await (await get("/metrics")).text()), undefined);
  await cache.set("queue-depth", 7);
  assert.match(depth(await (await get("/metrics")).text()), / 7$/);
  await cache.set("queue-depth", 0);
  assert.match(depth(await (await get("/metrics")).text()), / 0$/);
  await cache.delete("queue-depth");
  assert.equal(depth(await (await get("/metrics")).text()), undefined);
  assert.equal((await (await get("/version")).json()).service, "queue-api");
  assert.equal((await get("/missing")).status, 404);
  assert.match(await (await get("/metrics")).text(), /app_requests_total\{[^\n]*route="version"[^\n]*\} 1/);
  if (runtime === "node") await measureRequests();
  await cache.set("queue-depth", 9);
  await stop();
  // Previously passed readiness may remain valid for up to one second.
  await delay(1010);
  assert.equal((await get("/readyz")).status, 503);
  assert.equal((await get("/livez")).status, 200);
  const unavailable = await (await get("/metrics")).text();
  assert.equal(depth(unavailable), undefined);
  assert.match(unavailable, /defuss_o11y_observer_success\{[^\n]*observer="queue_depth"[^\n]*\} 0/);
  await start();
  assert.equal((await get("/readyz")).status, 200);
  assert.match(depth(await (await get("/metrics")).text()), / 9$/);
  console.log(JSON.stringify({ runtime, version: process.versions.bun ?? process.versions.node, backplane: "0.3.0",
    readiness: [503, 200, 503, 200], badCredentials: 503, livenessDuringOutage: 200,
    queueDepth: ["absent", 7, 0, "deleted", "offline", 9], hostRoutes: [200, 404], ...(runtime === "node" ? { requests } : {}) }));
} finally {
  try { await app.close(); } finally {
    try { await stop(); } finally { await rm(temp, { recursive: true, force: true }); }
  }
}
