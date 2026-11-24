import { duration, task, type Result, type Callback } from "./task.js";

export type Probe = "liveness" | "readiness";
export interface CheckOptions { probe?: Probe; maxAgeMs?: number }
export interface CheckResult {
  name: string;
  status: "pass" | "fail";
  reason?: "error" | "timeout" | "closed";
}
export interface HealthReport {
  service: string;
  status: "pass" | "fail";
  checks: CheckResult[];
}

export function healthRegistry(service: string, timeoutMs: number) {
  const entries = new Map<string, { probe: Probe; run(): Promise<Result<boolean>>; close(): void }>();
  let draining = false;
  let closed = false;

  function check(name: string, callback: Callback<boolean>, options: Probe | CheckOptions = "readiness") {
    if (typeof callback !== "function") throw new TypeError("Expected a check function");
    if (closed) throw new Error("Observability is closed");
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(name) || entries.has(name)) {
      throw new Error(`Invalid or duplicate check name: ${name}`);
    }
    if (entries.size >= 256) throw new Error("Limit of 256 active checks reached");
    const probe = typeof options === "string" ? options : options.probe ?? "readiness";
    const maxAgeMs = typeof options === "string" ? 0 : options.maxAgeMs ?? 0;
    if (maxAgeMs !== 0) duration(maxAgeMs, "maxAgeMs");
    if (probe !== "readiness" && probe !== "liveness") throw new Error("Invalid probe");
    // VERIFIED: expiry starts after a successful completion and an aborted callback cannot extend it.
    let freshUntil = -Infinity;
    const work = task(maxAgeMs === 0 ? callback : async signal => {
      const passed = await callback(signal);
      if (passed === true && !signal.aborted) freshUntil = performance.now() + maxAgeMs;
      return passed;
    }, timeoutMs);
    const entry = { probe, close: work.close, run: (): Promise<Result<boolean>> =>
      maxAgeMs && performance.now() < freshUntil ? Promise.resolve({ ok: true, value: true }) : work.run() };
    entries.set(name, entry);
    return () => {
      if (entries.get(name) === entry) entries.delete(name);
      entry.close();
    };
  }

  // VERIFIED: readiness includes local liveness conditions as well as dependency checks.
  async function health(probe: Probe = "readiness"): Promise<HealthReport> {
    if (probe !== "readiness" && probe !== "liveness") throw new Error("Invalid probe");
    if (closed || (draining && probe === "readiness")) return { service, status: "fail", checks: [] };
    const selected = [...entries].filter(([, entry]) => probe === "readiness" || entry.probe === probe);
    const checks = await Promise.all(selected.map(async ([name, entry]): Promise<CheckResult> => {
      const result = await entry.run();
      if (!result.ok) return { name, status: "fail", reason: result.reason };
      return { name, status: result.value === true ? "pass" : "fail" };
    }));
    const available = !closed && (probe === "liveness" || !draining);
    return { service, status: available && checks.every(c => c.status === "pass") ? "pass" : "fail", checks };
  }

  return { check, health, drain() { draining = true; }, close() {
    closed = true;
    for (const entry of entries.values()) entry.close();
    entries.clear();
  } };
}
