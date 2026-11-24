import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createO11y } from "defuss-o11y";
import { createServer } from "defuss-serve";
import serve from "defuss-serve/package.json" with { type: "json" };

const publicDir = await mkdtemp(join(tmpdir(), "o11y-serve-"));
const obs = createO11y({ serviceName: "serve-integration" });
const server = createServer({ host: "127.0.0.1", port: 0, publicDir, plugins: [
  { name: "o11y", matches: obs.matches, fetch: obs.fetch, close: obs.shutdown },
  { name: "app", matches: req => new URL(req.url).pathname === "/echo", fetch: async req => new Response(await req.text()) },
] });
try {
  await writeFile(join(publicDir, "hello.txt"), "static");
  await server.start();
  const get = (path, init) => fetch(new URL(path, server.url), init);
  const routes = {};
  for (const path of ["/health", "/healthz", "/readyz", "/livez", "/metrics", "/hello.txt"]) {
    const response = await get(path);
    assert.equal(response.status, 200);
    const body = await response.text();
    if (path === "/metrics") assert.match(body, /defuss_o11y_ready/);
    else if (path === "/hello.txt") assert.equal(body, "static");
    else assert.equal(JSON.parse(body).status, "pass");
    routes[path] = response.status;
  }
  assert.equal(await (await get("/echo", { method: "POST", body: "app" })).text(), "app");
  assert.equal((await get("/readyz", { method: "POST" })).status, 405);
  assert.equal((await get("/missing")).status, 404);
  obs.drain();
  assert.equal((await get("/readyz")).status, 503);
  assert.equal((await get("/livez")).status, 200);
  console.log(JSON.stringify({ runtime: server.runtime, version: process.versions.bun ?? process.versions.node,
    host: `defuss-serve ${serve.version}`, routes, echo: "app", unmatched: 404, invalidMethod: 405, drainedReadiness: 503 }));
} finally {
  try { await server.stop(); } finally { await obs.shutdown(); await rm(publicDir, { recursive: true, force: true }); }
}
