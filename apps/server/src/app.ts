import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { AppContext } from "./app-context.js";
import { AgentService } from "./agent/service.js";
import { registerAdminRoutes } from "./api/admin-routes.js";
import { registerAuthRoutes } from "./api/auth-routes.js";
import { registerNativeRoutes } from "./api/native-routes.js";
import type { AppConfig } from "./config.js";
import { ConfigStore } from "./db/config-store.js";
import { ConversationStore } from "./db/conversation-store.js";
import { openDatabase } from "./db/database.js";
import { TaskStore } from "./db/task-store.js";
import { OutboxStore } from "./db/outbox-store.js";
import { EphemeralMediaStore } from "./db/media-store.js";
import { UserStore } from "./db/user-store.js";
import { JackettClient } from "./integrations/jackett.js";
import { JellyfinClient } from "./integrations/jellyfin.js";
import { OpenListClient } from "./integrations/openlist.js";
import { TmdbClient } from "./integrations/tmdb.js";
import { SecretVault } from "./security/vault.js";

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: true,
  });
  await app.register(cookie);

  const db = openDatabase(config.databasePath);
  const vault = new SecretVault(config.masterKey);
  const users = new UserStore(db);
  const configs = new ConfigStore(db, vault);
  const conversations = new ConversationStore(db);
  const tasks = new TaskStore(db);
  const outbox = new OutboxStore(db);
  const media = new EphemeralMediaStore(db);
  const tmdb = new TmdbClient(configs);
  const jackett = new JackettClient(configs);
  const openList = new OpenListClient(configs);
  const jellyfin = new JellyfinClient(configs);
  const agent = new AgentService({
    configs,
    conversations,
    tasks,
    tmdb,
    jackett,
    openList,
    jellyfin,
    users,
    outbox,
    media,
    mediaBaseUrl: config.mediaBaseUrl,
  });
  const context: AppContext = {
    config,
    db,
    users,
    configs,
    conversations,
    tasks,
    outbox,
    media,
    tmdb,
    jackett,
    openList,
    jellyfin,
    agent,
  };

  app.get("/health", async () => ({
    status: "ok",
    setupRequired: users.count() === 0,
  }));
  app.get("/api/version", async () => ({
    name: "AutoFilm Core",
    version: "0.1.0",
  }));
  app.get<{ Params: { token: string } }>(
    "/v1/media/:token",
    async (request, reply) => {
      const item = media.consume(request.params.token);
      if (!item) return reply.code(404).send({ error: "Media not found" });
      return reply
        .header("cache-control", "no-store")
        .header(
          "content-disposition",
          `inline; filename="${item.fileName.replace(/["\r\n]/g, "_")}"`,
        )
        .type(item.contentType)
        .send(item.content);
    },
  );

  await registerAuthRoutes(app, context);
  await registerAdminRoutes(app, context);
  await registerNativeRoutes(app, context);

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = path.resolve(moduleDir, "../../web/dist");
  const hasWebBuild = existsSync(path.join(webRoot, "index.html"));
  if (hasWebBuild) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
    });
  }
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/v1/")) {
      return reply.code(404).send({ error: "Not found" });
    }
    if (hasWebBuild) return reply.type("text/html").sendFile("index.html");
    return reply.code(503).send({ error: "Frontend build is unavailable" });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    const normalized =
      error instanceof Error ? error : new Error("Unknown request error");
    const statusCode =
      "statusCode" in normalized &&
      typeof normalized.statusCode === "number"
        ? normalized.statusCode
        : undefined;
    const status =
      typeof statusCode === "number" && statusCode < 500
        ? statusCode
        : 500;
    return reply.code(status).send({
      error: status >= 500 ? "Internal server error" : normalized.message,
    });
  });
  app.addHook("onClose", async () => {
    db.close();
  });

  return { app, context };
}
