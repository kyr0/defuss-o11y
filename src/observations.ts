import { ValueType, type HrTime } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import { AggregationTemporality, DataPointType, type GaugeMetricData, type MetricProducer } from "@opentelemetry/sdk-metrics";
import type { HealthReport } from "./health.js";
import { finite, LabelSchema, type LabelAdditions, attributeKeys } from "./series.js";
import type { Observation, ObserverOptions, Point } from "./metrics.js";
import { task, type Callback } from "./task.js";

// VERIFIED: snapshot producers let a disappeared queue or failed observer withdraw its series on both readers.
export function observations(resource: Resource, timeoutMs: number, health: () => Promise<HealthReport>, limit: (name: string) => number) {
  const entries = new Map<string, { description: string; unit: string; work: ReturnType<typeof task<Point[]>> }>();

  function observe(name: string, callback: Callback<Observation>, { description = name, unit = "" }: ObserverOptions = {}) {
    const schema = new LabelSchema();
    const maximum = limit(name);
    const work = task(async signal => {
      const output = await callback(signal);
      signal.throwIfAborted();
      if (typeof output === "number") return [{ value: finite(output) }];
      const points = output;
      if (!Array.isArray(points) || points.length > maximum) throw new Error(`Expected at most ${maximum} points`);
      const seen = new Set<string>();
      const additions: LabelAdditions = new Map();
      const result = Array.from(points, (p: Point) => {
        const value = finite(p.value);
        const point = schema.point(p.attributes, attributeKeys(p.attributes), additions);
        if (seen.has(point.id)) throw new Error("Duplicate gauge series");
        seen.add(point.id);
        return { value, attributes: point.attributes };
      });
      schema.commit(additions);
      return result;
    }, timeoutMs);
    entries.set(name, { work, description, unit });
  }

  const producer: MetricProducer = {
    async collect() {
      const [report, collected] = await Promise.all([
        health(),
        Promise.all([...entries].map(async ([name, entry]) => ({
          name, description: entry.description, unit: entry.unit, result: await entry.work.run(),
        }))),
      ]);
      const now = Date.now();
      const time: HrTime = [Math.floor(now / 1000), (now % 1000) * 1e6];
      const metrics: GaugeMetricData[] = [];
      function gauge(name: string, description: string, points: readonly Point[], unit = "1") {
        if (!points.length) return;
        metrics.push({
          descriptor: { name, description, unit, valueType: ValueType.DOUBLE },
          dataPointType: DataPointType.GAUGE, aggregationTemporality: AggregationTemporality.CUMULATIVE,
          dataPoints: points.map(p => ({ value: p.value, attributes: p.attributes ?? {}, startTime: time, endTime: time })),
        });
      }
      gauge("process_uptime_seconds", "Time since process start", [{ value: process.uptime() }], "s");
      gauge("process_resident_memory_bytes", "Resident memory of the process", [{ value: process.memoryUsage.rss() }], "By");
      gauge("defuss_o11y_ready", "Readiness for serving traffic", [{ value: Number(report.status === "pass") }]);
      gauge("defuss_o11y_check_success", "Health check passed", report.checks.map(c => ({
        value: Number(c.status === "pass"), attributes: { check: c.name },
      })));
      gauge("defuss_o11y_observer_success", "Metric observer returned a valid snapshot", collected.map(c => ({
        value: Number(c.result.ok), attributes: { observer: c.name },
      })));
      for (const { name, description, unit, result } of collected) if (result.ok) gauge(name, description, result.value, unit);
      return { errors: [], resourceMetrics: { resource, scopeMetrics: [{ scope: { name: "defuss-o11y.observers", version: "0.3.0" }, metrics }] } };
    },
  };

  return { producer, observe, close() {
    for (const { work } of entries.values()) work.close();
    entries.clear();
  } };
}
