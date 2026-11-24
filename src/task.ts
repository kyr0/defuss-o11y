// VERIFIED: a timed-out callback still owns its slot until its underlying operation settles.
export type Callback<T> = (signal: AbortSignal) => T | Promise<T>;
export type Result<T> = { ok: true; value: T } | { ok: false; reason: "error" | "timeout" | "closed" };

export function duration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be a positive 32-bit integer`);
  }
  return value;
}

export function task<T>(callback: Callback<T>, timeoutMs: number) {
  let active: Promise<Result<T>> | undefined;
  let cancel: (() => void) | undefined;
  let closed = false;

  function run(): Promise<Result<T>> {
    if (closed) return Promise.resolve({ ok: false, reason: "closed" });
    if (active) return active;

    const controller = new AbortController();
    active = new Promise<Result<T>>(resolve => {
      function stop(reason: "timeout" | "closed") {
        clearTimeout(timer);
        resolve({ ok: false, reason });
        controller.abort(reason);
      }
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      cancel = () => stop("closed");
      void (async () => {
        // Defer invocation until the in-flight promise has been assigned.
        await Promise.resolve();
        try {
          controller.signal.throwIfAborted();
          const value = await callback(controller.signal);
          resolve({ ok: true, value });
        } catch {
          resolve({ ok: false, reason: "error" });
        } finally {
          clearTimeout(timer);
          cancel = undefined;
          active = undefined;
        }
      })();
    });
    return active;
  }

  return { run, close() { closed = true; cancel?.(); } };
}
