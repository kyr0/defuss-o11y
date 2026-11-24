# Backplane consumer

This application mounts defuss-o11y on its own Node-compatible HTTP listener. The included integration test starts the released defuss-backplane 0.3.0 daemon with a temporary data directory and a generated credential. Both the application and the daemon run under the selected runtime.

From this directory, install the locked packages, build the library and run the example test:

```sh
make -C ../.. setup build
node verify.mjs
bun verify.mjs
```

The Backplane example requires Node 26 or later, or Bun 1.4.5 or later. The library itself supports Node 22.15 and later. This folder is a workspace of the repository, so it uses the local defuss-o11y build. It installs defuss-backplane 0.3.0 from `vendor/`, and the repository lockfile pins the remaining dependencies.

To use an existing local daemon, set `API_KEY` to the daemon credential in the application's environment. `BACKPLANE_PORT` defaults to 43127 and `APP_PORT` defaults to 3000. Start the application with `node server.ts` or `bun server.ts`.

| Application path | Behavior |
| --- | --- |
| `/health`, `/readyz` | Checks that authenticated RPC schema discovery exposes the cache read method. Successful discovery is cached for 1000 ms. After expiry, a failed dependency or rejected credential returns 503. |
| `/healthz`, `/livez` | Reports application liveness independently of Backplane availability. |
| `/metrics` | Exports built-in metrics, successful version requests and the application's queue depth. A missing depth withdraws the series. A failed read also sets the observer-success gauge to zero. |
| `/version` | Application route. Demonstrates middleware fallthrough and a request counter. |

The example's `queue-api/local/metrics` cache bucket and `queue-depth` key are an application convention. A producer can write a nonnegative integer there using the Backplane client. The observer reads it on every collection. Cached readiness never suppresses a queue read. The Node verifier counts outgoing schema and cache RPCs for expired and warm checks. Schema discovery receives the check's AbortSignal. The Backplane 0.3.0 cache client has no per-call AbortSignal argument, so a timed-out cache read retains its observer slot until the underlying RPC settles.

The daemon keeps its existing RPC and MCP listener. To use this library inside another backend, install it with `bun add defuss-o11y` or `npm install defuss-o11y`, then register that backend's own functions on an instance of `createO11y`, then mount `obs.middleware` on the host router or use `obs.fetch` with Bun. The host controls authentication and which addresses expose the routes.
