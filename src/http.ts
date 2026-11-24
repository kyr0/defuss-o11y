import type { IncomingMessage, ServerResponse } from "node:http";
import type { HealthReport, Probe } from "./health.js";

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;
export const metricsContentType = "text/plain; version=0.0.4; charset=utf-8";

// VERIFIED: Express strips its mount prefix from req.url. Both adapters dispatch on the remaining path.
export function httpRoutes(health: (probe: Probe) => Promise<HealthReport>, metrics: () => Promise<string>) {
  function match(path: string): Probe | "metrics" | undefined {
    return path === "/health" || path === "/readyz" ? "readiness"
      : path === "/healthz" || path === "/livez" ? "liveness" : path === "/metrics" ? "metrics" : undefined;
  }

  async function route(path: string, method: string): Promise<Response | undefined> {
    const target = match(path);
    if (!target) return undefined;
    const headers = new Headers({ "cache-control": "no-store" });
    if (method !== "GET" && method !== "HEAD") {
      headers.set("allow", "GET, HEAD");
      return new Response(null, { status: 405, headers });
    }
    let body: string;
    let status = 200;
    if (target !== "metrics") {
      const report = await health(target);
      headers.set("content-type", "application/json; charset=utf-8");
      status = report.status === "pass" ? 200 : 503;
      body = JSON.stringify(report);
    } else {
      try {
        body = await metrics();
        headers.set("content-type", metricsContentType);
      } catch {
        status = 503;
        body = "Metrics unavailable\n";
        headers.set("content-type", "text/plain; charset=utf-8");
      }
    }
    return new Response(method === "HEAD" ? null : body, { status, headers });
  }

  const middleware: Middleware = (req, res, next) => {
    const path = (req.url ?? "/").split("?", 1)[0]!;
    void route(path, req.method ?? "GET").then(async response => {
      if (!response) return next();
      const body = await response.text();
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(body);
    }).catch(next);
  };

  function handle(request: Request) {
    return route(new URL(request.url).pathname, request.method);
  }
  return {
    middleware, handle,
    matches: (request: Request) => match(new URL(request.url).pathname) !== undefined,
    async fetch(request: Request) { return await handle(request) ?? new Response(null, { status: 404 }); },
  };
}
