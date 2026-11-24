import express from "express";
import { createO11y, type TelemetrySink } from "../src/index.js";

export function attach(app: ReturnType<typeof express>): TelemetrySink {
  const obs = createO11y({ serviceName: "contracts", maxSeriesPerInstrument: 250, seriesLimits: { requests: 10 } });
  app.use("/ops", obs.middleware);
  obs.check("configuration", async (signal: AbortSignal) => !signal.aborted);
  obs.observe("queue_depth", async () => [{ value: 0, attributes: { queue: "default" } }]);
  obs.check("ready", () => true, { maxAgeMs: 1000 });
  obs.bindCounter("requests", { route: "/health" })();
  obs.bindHistogram("duration")(1);
  obs.bindGauge("load")(-1);
  obs.defineHistogram("http.server.request.duration", { unit: "s", explicitBucketBoundaries: [0.1, 0.3, 1] });
  obs.bindHistogram("http.server.request.duration", { "http.request.method": "GET" })(0.08);
  return obs.sink;
}

export async function compose(obs: ReturnType<typeof createO11y>, request: Request, next: (req: Request) => Promise<Response>): Promise<Response> {
  return await obs.handle(request) ?? next(request);
}
