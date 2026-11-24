/** Metric labels. Same shape as defuss-open-telemetry 0.1.2, so defuss call sites typed against it keep compiling. */
export interface Attributes {
  [key: string]: string | number | boolean | undefined;
}

const empty: Attributes = Object.freeze({});
const overflow: Attributes = Object.freeze({ "otel.metric.overflow": true });
const labelName = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*$/;
const reserved = /^(?:le|quantile|otel_metric_overflow|otel_scope_.*)$/;
const maxKeys = 128;

export function finite(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("Metric value must be finite");
  return value;
}

export function seriesPolicy(defaultLimit = 2000, overrides: Readonly<Record<string, number>> = {}) {
  function limit(n: number) {
    if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_645) throw new RangeError("Invalid series limit");
    return n;
  }
  const perName = new Map<string, number>();
  let maximum = limit(defaultLimit);
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new TypeError("Expected series limits by name");
  for (const [name, size] of Object.entries(overrides)) {
    perName.set(name, limit(size));
    maximum = Math.max(maximum, size);
  }
  // VERIFIED: the SDK reserves one slot internally. Our overflow can arrive before an admitted series in a later interval.
  return { forName: (name: string) => perName.get(name) ?? defaultLimit, readerLimit: maximum + 2 };
}

export function attributeKeys(attrs?: Attributes): string[] {
  if (attrs === undefined) return [];
  if (attrs === null || typeof attrs !== "object" || Array.isArray(attrs)) throw new TypeError("Expected a label object");
  return Object.keys(attrs);
}

export type LabelAdditions = Map<string, { key: string; type: string }>;

// VERIFIED: only fully valid writes or observer snapshots commit newly discovered key types.
export class LabelSchema {
  private readonly types: LabelAdditions = new Map();

  point(raw: Attributes | undefined, keys: string[], additions: LabelAdditions) {
    const attributes: Attributes = Object.create(null);
    for (const key of keys) {
      const wireKey = key.includes(".") ? key.replace(/\./g, "_").replace(/_+/g, "_") : key;
      if (!labelName.test(key) || key.includes("__") || reserved.test(wireKey)) throw new Error(`Invalid label: ${key}`);
      const value = raw![key];
      if (value === undefined || value === "") continue;
      const type = typeof value;
      if (type !== "string" && type !== "boolean" && !(type === "number" && Number.isFinite(value))) {
        throw new Error(`Invalid label value: ${key}`);
      }
      const previous = this.types.get(wireKey) ?? additions.get(wireKey);
      if (previous && previous.key !== key) throw new Error(`Prometheus label collision: ${previous.key} and ${key}`);
      if (previous && previous.type !== type) throw new TypeError(`Label ${key} requires ${previous.type}, received ${type}`);
      if (previous === undefined) {
        if (this.types.size + additions.size >= maxKeys) throw new RangeError(`Limit of ${maxKeys} label keys per instrument reached`);
        additions.set(wireKey, { key, type });
      }
      attributes[key] = value;
    }
    const names = Object.keys(attributes);
    let id = "";
    if (names.length === 1) {
      const key = names[0]!;
      id = key + "=" + String(attributes[key]);
    } else if (names.length > 1) {
      id = JSON.stringify(names.sort().map(k => [k, attributes[k]]));
    }
    return { id, attributes: names.length ? attributes : empty, size: names.length };
  }

  commit(additions: LabelAdditions) {
    for (const [key, type] of additions) this.types.set(key, type);
  }
}

export class SeriesTable {
  private readonly schema = new LabelSchema();
  private readonly admitted = new Map<string, Attributes>();
  private last: { attributes: Attributes; size: number } | undefined;

  constructor(private readonly limit: number) {}

  select(raw?: Attributes): Attributes {
    const keys = attributeKeys(raw);
    const last = this.last;
    if (last && last.size === keys.length && keys.every(k => Object.hasOwn(last.attributes, k) && raw![k] === last.attributes[k])) {
      return last.attributes;
    }
    const additions: LabelAdditions = new Map();
    const point = this.schema.point(raw, keys, additions);
    this.schema.commit(additions);
    let attributes = this.admitted.get(point.id);
    if (!attributes) {
      if (this.admitted.size >= this.limit) return overflow;
      attributes = point.attributes;
      this.admitted.set(point.id, attributes);
    }
    this.last = { attributes, size: point.size };
    return attributes;
  }
}
