import { serve } from "bun";
import { createO11y } from "defuss-o11y";

const obs = createO11y({ serviceName: "backplane" });
const server = serve({ hostname: "127.0.0.1", port: 3000, fetch: obs.fetch });
process.once("SIGTERM", async () => {
  obs.drain();
  await server.stop();
  await obs.shutdown();
});
