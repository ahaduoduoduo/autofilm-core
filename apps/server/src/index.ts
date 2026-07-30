import { buildApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { ProgressWorker } from "./tasks/progress-worker.js";
import { OutboundMessageWorker } from "./channels/outbound.js";
import { WatchlistWorker } from "./tasks/watchlist-worker.js";
import { OpenListAuthWorker } from "./tasks/openlist-auth-worker.js";
import { DownloadCompletionWorker } from "./tasks/download-completion-worker.js";

const config = loadConfig();
const { app, context } = await buildApp(config);
await bootstrap(config, context.users, context.configs);

const progressWorker = new ProgressWorker(
  context.openList,
  context.tasks,
  2_000,
  context.outbox,
  context.jellyfin,
);
const outboundWorker = new OutboundMessageWorker(
  context.configs,
  context.users,
  context.outbox,
);
const watchlistWorker = new WatchlistWorker(
  context.watchlists,
  context.tmdb,
  context.agent,
  context.outbox,
  config.watchlistIntervalMs,
);
const openListAuthWorker = new OpenListAuthWorker(
  context.openList,
  context.configs,
  context.users,
  context.outbox,
);
const downloadCompletionWorker = new DownloadCompletionWorker(
  context.tasks,
  context.agent,
  context.outbox,
  config.mediaBaseUrl,
);
progressWorker.start();
outboundWorker.start();
watchlistWorker.start();
openListAuthWorker.start();
downloadCompletionWorker.start();
const mediaCleanupTimer = setInterval(
  () => {
    context.media.deleteExpired();
    context.subtitleWorkspaces.deleteExpired();
    context.users.deleteExpiredSessions();
    context.conversations.deleteProcessedEventsBefore(
      new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
    );
    context.outbox.deleteDeliveredBefore(
      new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
    );
  },
  60 * 60_000,
);
mediaCleanupTimer.unref();
app.addHook("onClose", async () => {
  progressWorker.stop();
  outboundWorker.stop();
  watchlistWorker.stop();
  openListAuthWorker.stop();
  downloadCompletionWorker.stop();
  clearInterval(mediaCleanupTimer);
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
