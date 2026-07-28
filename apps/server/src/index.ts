import { buildApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { ProgressWorker } from "./tasks/progress-worker.js";
import { OutboundMessageWorker } from "./channels/outbound.js";

const config = loadConfig();
const { app, context } = await buildApp(config);
await bootstrap(config, context.users, context.configs);

const progressWorker = new ProgressWorker(
  context.openList,
  context.tasks,
  15_000,
  context.outbox,
);
const outboundWorker = new OutboundMessageWorker(
  context.configs,
  context.users,
  context.outbox,
);
progressWorker.start();
outboundWorker.start();
const mediaCleanupTimer = setInterval(
  () => context.media.deleteExpired(),
  60 * 60_000,
);
mediaCleanupTimer.unref();
app.addHook("onClose", async () => {
  progressWorker.stop();
  outboundWorker.stop();
  clearInterval(mediaCleanupTimer);
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
