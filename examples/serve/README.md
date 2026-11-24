# defuss-serve integration

Run `make -C ../.. setup build`, then `node verify.mjs` or `bun verify.mjs`. This folder is a workspace of the repository, so it uses the local defuss-o11y build. It installs defuss-serve 0.3.0 from npm. It mounts all observability routes, an application endpoint and a static directory on a single listener. The host supports Node 22.16.0 and later.

In your own defuss-serve application, install defuss-o11y with `bun add defuss-o11y` or `npm install defuss-o11y` and register the plugin with `{ name: "o11y", matches: obs.matches, fetch: obs.fetch, close: obs.shutdown }`. The synchronous matcher uses the same paths as the handler, including readiness and liveness aliases. In a Fetch-first router, use `await obs.handle(request) ?? next(request)` instead.
