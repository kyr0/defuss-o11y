import { randomUUID } from "node:crypto";
import { PushReader, type OtlpOptions } from "./push.js";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, MetricReader, type IMetricReader } from "@opentelemetry/sdk-metrics";
import { healthRegistry, type CheckOptions, type Probe, type HealthReport } from "./health.js";
import { httpRoutes, type Middleware } from "./http.js";
import { instruments, validateMetadata, type HistogramOptions, type Observation, type ObserverOptions, type TelemetrySink } from "./metrics.js";
import { observations } from "./observations.js";
import { duration, type Callback } from "./task.js";
import { seriesPolicy, type Attributes } from "./series.js";

export type { Probe, CheckOptions, CheckResult, HealthReport } from "./health.js";
export type { Middleware } from "./http.js";
export type { ExportFailure, ExportSource, OtlpOptions } from "./push.js";
export type { HistogramOptions, Point, Observation, ObserverOptions, TelemetrySink } from "./metrics.js";
export type { Attributes } from "./series.js";
export type { Callback } from "./task.js";

export interface O11yOptions {
  serviceName: string;
  serviceVersion?: string;
  /** Normal series admitted per instrument. An additional series carries overflow. Default 2000. */
  maxSeriesPerInstrument?: number;
  /** Overrides keyed by the original instrument name. */
  seriesLimits?: Readonly<Record<string, number>>;
  instanceId?: string;
  /** Deadline per async health check or observer, default 1000 ms. */
  timeoutMs?: number;
  /** Enable OTLP/HTTP JSON push. endpoint is the full metrics URL. */
  otlp?: true | OtlpOptions;
}
export interface O11y {
  check(name: string, callback: Callback<boolean>, options?: Probe | CheckOptions): () => void;
  observe(name: string, callback: Callback<Observation>, options?: ObserverOptions): void;
  readonly sink: TelemetrySink;
  defineHistogram(name: string, options?: HistogramOptions): void;
  bindCounter(name: string, attributes?: Attributes): (increment?: number) => void;
  bindHistogram(name: string, attributes?: Attributes): (value: number) => void;
  bindGauge(name: string, attributes?: Attributes): (value: number) => void;
  health(probe?: Probe): Promise<HealthReport>;
  metrics(): Promise<string>;
  readonly middleware: Middleware;
  matches(request: Request): boolean;
  handle(request: Request): Promise<Response | undefined>;
  fetch(request: Request): Promise<Response>;
  drain(): void;
  /** Invoke the configured metric readers' forceFlush. */
  flush(options?: { strict?: boolean }): Promise<void>;
  shutdown(): Promise<void>;
}

// VERIFIED: the host serves the scrape. This reader owns no listener, buffer or timer.
class ScrapeReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

export function createO11y(options: O11yOptions): O11y {
  if (!options.serviceName?.trim()) throw new Error("serviceName is required");
  const timeoutMs = duration(options.timeoutMs ?? 1000, "timeoutMs");
  const policy = seriesPolicy(options.maxSeriesPerInstrument, options.seriesLimits);
  const resource = defaultResource().merge(resourceFromAttributes({
    "service.name": options.serviceName,
    "service.instance.id": options.instanceId ?? randomUUID(),
    ...(options.serviceVersion ? { "service.version": options.serviceVersion } : {}),
  }));
  const probes = healthRegistry(options.serviceName, timeoutMs);
  const live = observations(resource, timeoutMs, probes.health, policy.forName);
  const metricProducers = [live.producer];
  const scrape = new ScrapeReader({ metricProducers, cardinalitySelector: () => policy.readerLimit });
  const serializer = new PrometheusSerializer();
  const readers: IMetricReader[] = [scrape];
  const pushEnabled = Boolean(options.otlp);
  if (options.otlp) {
    const config = options.otlp === true ? {} : options.otlp;
    const { endpoint } = config;
    if (config.onExportError !== undefined && typeof config.onExportError !== "function") throw new TypeError("Expected onExportError callback");
    const url = endpoint === undefined ? undefined : new URL(endpoint);
    if (url && (!["http:", "https:"].includes(url.protocol) || url.hash || url.username || url.password)) {
      throw new Error("Expected an HTTP(S) OTLP metrics endpoint without credentials or fragment");
    }
    const interval = duration(config.intervalMs ?? 60_000, "otlp.intervalMs");
    const timeout = duration(config.timeoutMs ?? Math.min(10_000, interval), "otlp.timeoutMs");
    if (timeout > interval || timeout <= timeoutMs) throw new Error("Require callback timeout < OTLP timeout <= interval");
    readers.push(new PushReader(url?.href, { ...config }, interval, timeout, live.producer, policy.readerLimit));
  }
  const provider = new MeterProvider({ resource, readers });
  let closing: Promise<void> | undefined;
  const assertOpen = () => { if (closing) throw new Error("Observability is closed"); };
  const registry = instruments(provider.getMeter("defuss-o11y", "0.3.0"), assertOpen, policy.forName);
  let collecting: Promise<string> | undefined;
  function metrics(): Promise<string> {
    if (closing) return Promise.reject(new Error("Observability is closed"));
    collecting ??= scrape.collect().then(({ resourceMetrics, errors }) => {
      if (errors.length) throw new AggregateError(errors, "Metric collection failed");
      return serializer.serialize(resourceMetrics).trimEnd() + "\n";
    }).finally(() => { collecting = undefined; });
    return collecting;
  }

  function shutdown(): Promise<void> {
    if (!closing) {
      probes.drain();
      // Keep observers available for the SDK's final export.
      closing = Promise.resolve().then(() => provider.shutdown()).finally(() => {
        live.close();
        probes.close();
      });
    }
    return closing;
  }
  return {
    check(name, callback, probe) { assertOpen(); return probes.check(name, callback, probe); },
    observe(name, callback, options) {
      if (typeof callback !== "function") throw new TypeError("Expected an observer function");
      validateMetadata(options);
      registry.claimObserver(name);
      live.observe(name, callback, options);
    },
    defineHistogram: registry.defineHistogram, bindCounter: registry.bindCounter, bindHistogram: registry.bindHistogram, bindGauge: registry.bindGauge,
    sink: registry.sink, health: probes.health, drain: probes.drain, metrics,
    async flush({ strict = false } = {}) {
      assertOpen();
      if (strict && !pushEnabled) throw new Error("Strict flush requires OTLP export to be enabled");
      try { await provider.forceFlush(); } catch (error) { if (strict) throw error; }
    }, shutdown,
    ...httpRoutes(probes.health, metrics),
  };
}
