import express from "express";
import { statfs } from "node:fs/promises";
import { createO11y } from "defuss-o11y";

const app = express();
const obs = createO11y({ serviceName: "backplane", otlp: true });
obs.check("storage", async () => (await statfs(".")).bavail > 0);
obs.observe("storage_free_bytes", async () => {
  const fs = await statfs(".");
  return fs.bavail * fs.bsize;
}, { unit: "By" });
app.use(obs.middleware);
const server = app.listen(3000, "127.0.0.1");
process.once("SIGTERM", () => {
  obs.drain();
  server.close(() => { void obs.shutdown().catch(() => { process.exitCode = 1; }); });
});
