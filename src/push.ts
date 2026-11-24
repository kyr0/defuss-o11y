import type { Agent } from "node:http";
import { context, diag } from "@opentelemetry/api";
import { ExportResultCode, suppressTracing } from "@opentelemetry/core";
import { OTLPMetricExporterBase } from "@opentelemetry/exporter-metrics-otlp-http";
import { convertLegacyHttpOptions, createOtlpHttpExportDelegate } from "@opentelemetry/otlp-exporter-base/node-http";
import { JsonMetricsSerializer, MetricsExporterMetricsHelper, type IExportMetricsServiceResponse } from "@opentelemetry/otlp-transformer";
import { MetricReader, type MetricProducer, type ResourceMetrics } from "@opentelemetry/sdk-metrics";

export type ExportSource = "periodic" | "flush" | "shutdown";
export interface ExportFailure { source: ExportSource; error: Error }
export interface OtlpOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  intervalMs?: number;
  timeoutMs?: number;
  onExportError?: (failure: ExportFailure) => void | Promise<void>;
}

const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

// VERIFIED: the SDK delegate reports HTTP 200 with partial rejection as success.
// The per-reader serializer sees its acknowledgement before the exporter callback fires.
function transport(url: string | undefined, headers: OtlpOptions["headers"], timeoutMillis: number) {
  let acknowledged = false;
  let acknowledgementError: Error | undefined;
  const decoder = new TextDecoder();
  const serializer = {
    serializeRequest: JsonMetricsSerializer.serializeRequest,
    deserializeResponse(bytes: Uint8Array): IExportMetricsServiceResponse {
      acknowledged = true;
      try {
        const response = bytes.length ? JSON.parse(decoder.decode(bytes)) : {};
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Invalid OTLP acknowledgement");
        const partial = response.partialSuccess;
        if (partial != null && (typeof partial !== "object" || Array.isArray(partial))) throw new Error("Invalid OTLP partialSuccess");
        const rejected = partial?.rejectedDataPoints ?? 0;
        if (!((typeof rejected === "number" && Number.isSafeInteger(rejected) && rejected >= 0)
            || (typeof rejected === "string" && /^\d+$/.test(rejected)))) throw new Error("Invalid OTLP rejectedDataPoints");
        if (/[1-9]/.test(String(rejected))) acknowledgementError = new Error(`OTLP receiver rejected ${rejected} data points`);
        return response;
      } catch (error) {
        acknowledgementError = asError(error);
        return {};
      }
    },
  };
  const config = convertLegacyHttpOptions({ url, headers, timeoutMillis }, "METRICS", "v1/metrics", { "Content-Type": "application/json" });
  let agent: Agent | undefined;
  const ownedConfig = { ...config, agentFactory: async (protocol: string) => agent = await config.agentFactory(protocol) };
  const delegate = createOtlpHttpExportDelegate(ownedConfig, serializer, "otlp_http_metric_exporter", MetricsExporterMetricsHelper, undefined);
  const exporter = new OTLPMetricExporterBase(delegate);
  async function send(data: ResourceMetrics, signal: AbortSignal) {
    acknowledged = false;
    acknowledgementError = undefined;
    const abort = () => agent?.destroy();
    signal.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        context.with(suppressTracing(context.active()), () => exporter.export(data, result => {
          if (result.code !== ExportResultCode.SUCCESS) reject(result.error ?? new Error("OTLP export failed"));
          else if (!acknowledged) reject(new Error("Incomplete OTLP acknowledgement"));
          else if (acknowledgementError) reject(acknowledgementError);
          else resolve();
        }));
      });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async function close() {
    try { await exporter.shutdown(); } finally { agent?.destroy(); }
  }
  return { exporter, send, close };
}

interface Batch {
  signal: AbortSignal;
  result: Promise<void>;
  finish(error?: Error): void;
}

// VERIFIED: one active transport and one queued collection keep a flush after a new write
// from acknowledging a previously collected batch. Callers waiting for the same collection share it.
export class PushReader extends MetricReader {
  private readonly transport: ReturnType<typeof transport>;
  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  private queued?: Batch;

  constructor(url: string | undefined, private readonly options: OtlpOptions, private readonly interval: number,
    private readonly timeout: number, producer: MetricProducer, readerLimit: number) {
    const wire = transport(url, options.headers, timeout);
    super({ metricProducers: [producer], cardinalitySelector: () => readerLimit,
      aggregationSelector: wire.exporter.selectAggregation.bind(wire.exporter),
      aggregationTemporalitySelector: wire.exporter.selectAggregationTemporality.bind(wire.exporter) });
    this.transport = wire;
  }

  protected onInitialized() {
    this.timer = setInterval(() => {
      if (!this.active && !this.queued) void this.request("periodic").catch(() => {});
    }, this.interval);
    this.timer.unref();
  }

  private request(source: ExportSource): Promise<void> {
    if (this.queued) return this.queued.result;
    const controller = new AbortController();
    let pass!: () => void, fail!: (error: Error) => void;
    const result = new Promise<void>((resolve, reject) => { pass = resolve; fail = reject; });
    let settled = false;
    const batch: Batch = { signal: controller.signal, result, finish: error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (!error) { pass(); return; }
      fail(error);
      diag.error("defuss-o11y OTLP %s failed: %s", source, error.message);
      // A failing diagnostic callback cannot change the export or serving result.
      void Promise.resolve().then(() => this.options.onExportError?.({ source, error })).catch(() => {});
    } };
    const deadline = setTimeout(() => {
      const error = new Error(`OTLP export timed out after ${this.timeout} ms`);
      controller.abort(error);
      if (this.queued === batch) this.queued = undefined;
      batch.finish(error);
    }, this.timeout);
    this.queued = batch;
    queueMicrotask(() => void this.pump());
    return result;
  }

  private async pump() {
    const batch = this.queued;
    if (this.active || !batch) return;
    this.queued = undefined;
    this.active = true;
    try {
      const { resourceMetrics, errors } = await this.collect({ timeoutMillis: this.timeout });
      if (errors.length) throw new AggregateError(errors, "OTLP metric collection failed");
      await resourceMetrics.resource.waitForAsyncAttributes?.();
      batch.signal.throwIfAborted();
      if (resourceMetrics.scopeMetrics.length) await this.transport.send(resourceMetrics, batch.signal);
      await this.transport.exporter.forceFlush();
      batch.finish();
    } catch (error) {
      batch.finish(asError(error));
    } finally {
      this.active = false;
      if (this.queued) void this.pump();
    }
  }

  protected onForceFlush() { return this.request("flush"); }

  protected async onShutdown() {
    clearInterval(this.timer);
    try { await this.request("shutdown"); } catch { /* Failure is delivered to the instance hook. */ }
    await this.transport.close();
  }
}
