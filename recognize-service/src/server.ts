import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { startRecognizeWorker, stopRecognizeWorker } from "./modules/jobs/worker.js";

const app = buildApp();
startRecognizeWorker(app.log);

process.on("SIGINT", () => {
  stopRecognizeWorker();
});

process.on("SIGTERM", () => {
  stopRecognizeWorker();
});

app.listen({ host: env.HOST, port: env.PORT }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
