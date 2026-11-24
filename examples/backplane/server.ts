import { createServer } from "node:http";
import { once } from "node:events";
import { connectBackplane } from "defuss-backplane/client";
import { createO11y } from "defuss-o11y";

export async function startBackend(config: { apiKey: string; backplanePort: number; port: number }) {
  if (!config.apiKey) throw new Error("API_KEY is required");
  if (!Number.isInteger(config.backplanePort) || config.backplanePort < 1 || config.backplanePort > 65535) {
    throw new RangeError("Invalid backplane port");
  }
  const obs = createO11y({ serviceName: "queue-api" });
  const schemaUrl = `http://127.0.0.1:${config.backplanePort}/rpc/schema`;
  obs.check("backplane", async signal => {
    const response = await fetch(schemaUrl, {
      method: "POST", signal, redirect: "error",
      headers: { authorization: "Bearer " + config.apiKey, "content-type": "application/json" },
    });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const modules: Array<{ moduleName?: string; methods?: Record<string, unknown> }> = await response.json();
    return modules.some(m => m.moduleName === "cache" && m.methods && Object.hasOwn(m.methods, "get"));
  }, { maxAgeMs: 1000 });

  let connection: ReturnType<typeof connectBackplane> | undefined;
  obs.observe("queue_depth", async () => {
    // Discovery is lazy so liveness can start before the dependency.
    connection ??= connectBackplane({ app: "queue-api", apiKey: config.apiKey, port: config.backplanePort })
      .catch(error => { connection = undefined; throw error; });
    const client = await connection;
    const result = await client.tenant("local").cache("metrics").get("queue-depth");
    if (!result.hit) return [];
    if (typeof result.value !== "number" || !Number.isSafeInteger(result.value) || result.value < 0) {
      throw new TypeError("Expected a nonnegative integer queue depth");
    }
    return result.value;
  }, { description: "Pending jobs reported by the application", unit: "{job}" });

  const recordVersion = obs.bindCounter("app_requests", { route: "version" });
  const server = createServer((req, res) => {
    obs.middleware(req, res, error => {
      if (error) { res.writeHead(500).end(); return; }
      if (req.method === "GET" && req.url === "/version") {
        recordVersion();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ service: "queue-api" }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  try {
    server.listen(config.port, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    await obs.shutdown();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return {
    url: "http://127.0.0.1:" + address.port,
    async close() {
      obs.drain();
      try {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } finally { await obs.shutdown(); }
    },
  };
}

if (import.meta.main) {
  const app = await startBackend({
    port: Number(process.env.APP_PORT ?? 3000), backplanePort: Number(process.env.BACKPLANE_PORT ?? 43127),
    apiKey: process.env.API_KEY ?? "",
  });
  console.log(app.url);
  process.once("SIGTERM", () => void app.close());
  process.once("SIGINT", () => void app.close());
}
