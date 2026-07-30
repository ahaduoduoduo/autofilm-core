import { TelegramAdapter } from "./adapter.js";
import { loadConfig } from "./config.js";

const adapter = new TelegramAdapter(loadConfig());
await adapter.start();

async function shutdown(): Promise<void> {
  await adapter.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
