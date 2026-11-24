import type { Meter, MetricOptions } from "@opentelemetry/api";
import { finite, SeriesTable, type Attributes } from "./series.js";

/** The defuss metrics facade, structurally identical to defuss-open-telemetry 0.1.2, so `obs.sink` fits where defuss code expects that sink. */
export interface TelemetrySink {
  /** Increment a named counter. The default increment is 1. */
  incrementCounter(name: string, value?: number, attributes?: Attributes): void;
  /** Record one histogram measurement. */
  recordHistogram(name: string, value: number, attributes?: Attributes): void;
  /** Set the current value of the gauge series selected by the attributes. */
  setGauge(name: string, value: number, attributes?: Attributes): void;
}

export interface ObserverOptions { description?: string; unit?: string }
export interface HistogramOptions extends ObserverOptions { explicitBucketBoundaries?: readonly number[] }

// VERIFIED: the Prometheus serializer throws on a non-string description, failing every later scrape.
export function validateMetadata({ unit, description }: ObserverOptions = {}) {
  if (unit !== undefined && (typeof unit !== "string" || !/^[!-~]{0,63}$/.test(unit))) throw new Error("Invalid metric unit");
  if (description !== undefined && typeof description !== "string") throw new TypeError("Invalid metric description");
}

export interface Point { value: number; attributes?: Attributes }
export type Observation = number | readonly Point[];
type Kind = "counter" | "histogram" | "gauge";
type RecordValue = (value: number, attrs: Attributes) => void;
interface Writer { kind: Kind; table: SeriesTable; record: RecordValue }
const systemNames = ["process_uptime_seconds", "process_resident_memory_bytes", "defuss_o11y_ready",
  "defuss_o11y_check_success", "defuss_o11y_observer_success", "target_info", "otel_scope_info"];

function measurement(kind: Kind, value: number) {
  if (finite(value) < 0 && kind !== "gauge") throw new RangeError(`${kind} measurements must be non-negative`);
}

export function instruments(meter: Meter, assertOpen: () => void, limit: (name: string) => number) {
  const writers = new Map<string, Writer>();
  const exposed = new Set(systemNames);
  let count = 0;

  function claim(name: string, kind: Kind | "observer") {
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,254}$/.test(name)) throw new Error(`Invalid metric: ${name}`);
    if (count >= 256) throw new Error("Limit of 256 application instruments reached");
    const sanitized = name.replace(/[.-]/g, "_").replace(/_+/g, "_");
    const base = sanitized.toLowerCase();
    const reserved = [base];
    // The exporter appends _total case-sensitively to the sanitized metric name.
    if (kind === "counter" && !sanitized.endsWith("_total")) reserved.push(base + "_total");
    if (kind === "histogram") reserved.push(base + "_bucket", base + "_count", base + "_sum");
    if (reserved.some(key => exposed.has(key))) throw new Error(`Metric name collision: ${name}`);
    for (const key of reserved) exposed.add(key);
    count++;
  }

  function prepare(name: string, kind: Kind, attrs?: Attributes) {
    const known = writers.get(name);
    if (known) {
      if (known.kind !== kind) throw new Error(`Reused metric name: ${name}`);
      return { record: known.record, dimensions: known.table.select(attrs) };
    }
    const table = new SeriesTable(limit(name));
    const dimensions = table.select(attrs);
    const record = createWriter(name, kind, table);
    return { record, dimensions };
  }

  function createWriter(name: string, kind: Kind, table: SeriesTable, options?: MetricOptions) {
    claim(name, kind);
    let record: RecordValue;
    if (kind === "counter") {
      const counter = meter.createCounter(name);
      record = (v, a) => counter.add(v, a);
    } else if (kind === "histogram") {
      const histogram = meter.createHistogram(name, options);
      record = (v, a) => histogram.record(v, a);
    } else {
      const gauge = meter.createGauge(name);
      record = (v, a) => gauge.record(v, a);
    }
    writers.set(name, { kind, table, record });
    return record;
  }

  // VERIFIED: declaring a histogram allocates its SDK descriptor without admitting a label set.
  function defineHistogram(name: string, options: HistogramOptions = {}) {
    assertOpen();
    validateMetadata(options);
    const { unit, description, explicitBucketBoundaries: bounds } = options;
    if (bounds !== undefined && !Array.isArray(bounds)) throw new TypeError("Expected an array of bucket boundaries");
    const boundaries = bounds === undefined ? undefined : Array.from(bounds);
    if (boundaries?.some((n, i) => !Number.isFinite(n) || (i > 0 && n <= boundaries[i - 1]!))) {
      throw new RangeError("Histogram bucket boundaries must be finite and strictly increasing");
    }
    createWriter(name, "histogram", new SeriesTable(limit(name)), {
      unit, description, advice: boundaries === undefined ? undefined : { explicitBucketBoundaries: boundaries },
    });
  }

  function write(name: string, kind: Kind, value: number, attrs?: Attributes) {
    assertOpen();
    measurement(kind, value);
    const { record, dimensions } = prepare(name, kind, attrs);
    record(value, dimensions);
  }

  // VERIFIED: a bound handle captures library-owned dimensions and shares admission with the dynamic sink.
  function bind(name: string, kind: Kind, attrs?: Attributes) {
    assertOpen();
    const { record, dimensions } = prepare(name, kind, attrs);
    return (value: number) => {
      assertOpen();
      measurement(kind, value);
      record(value, dimensions);
    };
  }

  const sink: TelemetrySink = {
    incrementCounter(name, value = 1, attrs) { write(name, "counter", value, attrs); },
    recordHistogram(name, value, attrs) { write(name, "histogram", value, attrs); },
    setGauge(name, value, attrs) { write(name, "gauge", value, attrs); },
  };
  return {
    sink, defineHistogram,
    bindCounter(name: string, attrs?: Attributes) {
      const add = bind(name, "counter", attrs);
      return (value = 1) => add(value);
    },
    bindHistogram(name: string, attrs?: Attributes) { return bind(name, "histogram", attrs); },
    bindGauge(name: string, attrs?: Attributes) { return bind(name, "gauge", attrs); },
    claimObserver(name: string) { assertOpen(); claim(name, "observer"); },
  };
}
