import type { FastifyInstance, FastifyReply } from "fastify";
import { AI_PROTOCOLS } from "@autofilm/contracts";
import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { hashPassword } from "../security/password.js";
import { createToken } from "../security/tokens.js";
import { requireAdmin } from "./auth.js";

const providerSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  protocol: z.enum(AI_PROTOCOLS),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  customHeaders: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
});

const modelSchema = z.object({
  id: z.string().uuid().optional(),
  providerId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  isDefault: z.boolean().default(false),
  enabled: z.boolean().default(true),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxOutputTokens: z.number().int().positive().max(1_000_000).nullable().optional(),
});

const memberSchema = z.object({
  username: z.string().trim().min(3).max(64),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(256).optional(),
  role: z.enum(["owner", "admin", "member"]).default("member"),
});

const memberUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(12).max(256).optional(),
  role: z.enum(["owner", "admin", "member"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

const identitySchema = z.object({
  userId: z.string().uuid().nullable(),
  status: z.enum(["pending", "active", "blocked"]),
});

const channelSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  type: z.enum(["native", "telegram"]),
  providerInstanceId: z.string().trim().min(1).max(200),
  baseUrl: z.union([z.literal(""), z.string().url()]).default(""),
  inboundToken: z.string().min(24).optional(),
  outboundToken: z.string().optional(),
  enabled: z.boolean().default(true),
});

const serviceSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  type: z.enum(["openlist", "jellyfin", "jackett", "tmdb"]),
  baseUrl: z.union([z.literal(""), z.string().url()]),
  credential: z.string().optional(),
  options: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

export async function registerAdminRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/admin/")) return;
    await requireAdmin(request, reply, context);
  });

  app.get("/api/admin/dashboard", async () => {
    const tasks = context.tasks.list(200);
    return {
      members: context.users.listMembers().length,
      pendingIdentities: context.users
        .listIdentities()
        .filter((item) => item.status === "pending").length,
      activeTasks: tasks.filter((task) =>
        ["queued", "running", "waiting"].includes(task.state),
      ).length,
      failedTasks: tasks.filter((task) => task.state === "failed").length,
      providers: context.configs.listProviders().length,
      services: context.configs.listServices().length,
    };
  });

  app.get("/api/admin/ai/providers", async () => context.configs.listProviders());
  app.post("/api/admin/ai/providers", async (request, reply) => {
    const input = parse(providerSchema, request.body, reply);
    return input ? context.configs.saveProvider(input) : undefined;
  });
  app.delete<{ Params: { id: string } }>(
    "/api/admin/ai/providers/:id",
    async (request) => {
      context.configs.deleteProvider(request.params.id);
      return { ok: true };
    },
  );

  app.get("/api/admin/ai/models", async () => context.configs.listModels());
  app.post("/api/admin/ai/models", async (request, reply) => {
    const input = parse(modelSchema, request.body, reply);
    return input ? context.configs.saveModel(input) : undefined;
  });
  app.delete<{ Params: { id: string } }>(
    "/api/admin/ai/models/:id",
    async (request) => {
      context.configs.deleteModel(request.params.id);
      return { ok: true };
    },
  );
  app.post("/api/admin/ai/test", async (request, reply) => {
    const input = parse(
      z.object({
        modelId: z.string().uuid(),
        message: z.string().trim().min(1).max(4000),
      }),
      request.body,
      reply,
    );
    return input ? context.agent.testModel(input) : undefined;
  });

  app.get("/api/admin/members", async () => context.users.listMembers());
  app.post("/api/admin/members", async (request, reply) => {
    const actor = await requireAdmin(request, reply, context);
    if (!actor) return;
    const input = parse(memberSchema, request.body, reply);
    if (!input) return;
    if (input.role === "owner" && actor.role !== "owner") {
      return reply.code(403).send({ error: "Only an owner can create another owner" });
    }
    return context.users.create({
      username: input.username,
      displayName: input.displayName,
      passwordHash: input.password
        ? await hashPassword(input.password)
        : undefined,
      role: input.role,
    });
  });
  app.patch<{ Params: { id: string } }>(
    "/api/admin/members/:id",
    async (request, reply) => {
      const actor = await requireAdmin(request, reply, context);
      if (!actor) return;
      const input = parse(memberUpdateSchema, request.body, reply);
      if (!input) return;
      const target = context.users.findById(request.params.id);
      if (!target) return reply.code(404).send({ error: "Member not found" });
      if (
        actor.role !== "owner" &&
        (target.role === "owner" || input.role === "owner")
      ) {
        return reply.code(403).send({ error: "Only an owner can change owner accounts" });
      }
      if (actor.id === target.id && input.status === "disabled") {
        return reply.code(409).send({ error: "You cannot disable your own account" });
      }
      const removesActiveOwner =
        target.role === "owner" &&
        target.status === "active" &&
        (input.role !== undefined && input.role !== "owner" ||
          input.status === "disabled");
      if (removesActiveOwner && context.users.ownerCount() <= 1) {
        return reply.code(409).send({ error: "The last active owner must be preserved" });
      }
      context.users.update(request.params.id, {
        displayName: input.displayName,
        role: input.role,
        status: input.status,
        passwordHash: input.password
          ? await hashPassword(input.password)
          : undefined,
      });
      return { ok: true };
    },
  );

  app.get("/api/admin/identities", async () => context.users.listIdentities());
  app.patch<{ Params: { id: string } }>(
    "/api/admin/identities/:id",
    async (request, reply) => {
      const input = parse(identitySchema, request.body, reply);
      if (!input) return;
      context.users.bindIdentity(request.params.id, input.userId, input.status);
      return { ok: true };
    },
  );

  app.get("/api/admin/channels", async () => context.configs.listChannels());
  app.post("/api/admin/channels", async (request, reply) => {
    const input = parse(channelSchema, request.body, reply);
    return input ? context.configs.saveChannel(input) : undefined;
  });
  app.post("/api/admin/channels/token", async () => ({
    token: createToken(),
  }));
  app.delete<{ Params: { id: string } }>(
    "/api/admin/channels/:id",
    async (request) => {
      context.configs.deleteChannel(request.params.id);
      return { ok: true };
    },
  );

  app.get("/api/admin/services", async () => context.configs.listServices());
  app.post("/api/admin/services", async (request, reply) => {
    const input = parse(serviceSchema, request.body, reply);
    return input ? context.configs.saveService(input) : undefined;
  });
  app.delete<{ Params: { id: string } }>(
    "/api/admin/services/:id",
    async (request) => {
      context.configs.deleteService(request.params.id);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/admin/services/:id/test",
    async (request, reply) => {
      const service = context.configs.serviceById(request.params.id);
      if (!service) return reply.code(404).send({ error: "Service not found" });
      if (!service.enabled) {
        return reply.code(409).send({ error: "Service is disabled" });
      }
      switch (service.type) {
        case "openlist":
          return context.openList.scheduler();
        case "jellyfin":
          return context.jellyfin.systemInfo();
        case "tmdb":
          return { results: await context.tmdb.trending() };
        case "jackett":
          return { results: await context.jackett.search("test") };
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/services/:id/openlist/auth-sessions",
    async (request, reply) => {
      const service = context.configs.serviceById(request.params.id);
      if (!service || service.type !== "openlist" || !service.enabled) {
        return reply.code(404).send({ error: "OpenList service not found" });
      }
      const input = parse(
        z.object({ storageId: z.number().int().positive() }),
        request.body,
        reply,
      );
      return input ? context.openList.startAuth(input.storageId) : undefined;
    },
  );
  app.get<{
    Params: { id: string; sessionId: string };
    Querystring: { storageId?: string };
  }>(
    "/api/admin/services/:id/openlist/auth-sessions/:sessionId",
    async (request, reply) => {
      const service = context.configs.serviceById(request.params.id);
      if (!service || service.type !== "openlist" || !service.enabled) {
        return reply.code(404).send({ error: "OpenList service not found" });
      }
      const storageId = Number(request.query.storageId);
      if (!Number.isInteger(storageId) || storageId <= 0) {
        return reply.code(400).send({ error: "Invalid storageId" });
      }
      return context.openList.authStatus(storageId, request.params.sessionId);
    },
  );
  app.get<{
    Params: { id: string; sessionId: string };
    Querystring: { storageId?: string };
  }>(
    "/api/admin/services/:id/openlist/auth-sessions/:sessionId/qrcode.png",
    async (request, reply) => {
      const service = context.configs.serviceById(request.params.id);
      if (!service || service.type !== "openlist" || !service.enabled) {
        return reply.code(404).send({ error: "OpenList service not found" });
      }
      const storageId = Number(request.query.storageId);
      if (!Number.isInteger(storageId) || storageId <= 0) {
        return reply.code(400).send({ error: "Invalid storageId" });
      }
      const image = await context.openList.authQrCode(
        storageId,
        request.params.sessionId,
      );
      return reply.type("image/png").send(image);
    },
  );

  app.get("/api/admin/tasks", async () => context.tasks.list(200));
  app.post("/api/admin/agent/test", async (request, reply) => {
    const input = parse(
      z.object({
        message: z.string().trim().min(1).max(4000),
      }),
      request.body,
      reply,
    );
    if (!input) return;
    const user = await requireAdmin(request, reply, context);
    if (!user) return;
    return {
      content: await context.agent.respond({
        userId: user.id,
        channel: "web",
        providerInstanceId: "admin",
        externalConversationId: user.id,
        text: input.message,
      }),
    };
  });
}

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  reply: FastifyReply,
): T | undefined {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    void reply.code(400).send({
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    });
    return undefined;
  }
  return parsed.data;
}
