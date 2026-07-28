import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { hashPassword, verifyPassword } from "../security/password.js";
import {
  createSession,
  currentUser,
  deleteSession,
} from "./auth.js";

const setupSchema = z.object({
  username: z.string().trim().min(3).max(64),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(256),
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  app.get("/api/setup/status", async () => ({
    required: context.users.count() === 0,
  }));

  app.post("/api/setup", async (request, reply) => {
    if (context.users.count() !== 0) {
      return reply.code(409).send({ error: "Setup has already completed" });
    }
    const input = parse(setupSchema, request.body, reply);
    if (!input) return;
    const user = context.users.create({
      username: input.username,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      role: "owner",
    });
    createSession(reply, context, user.id);
    return { user };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = parse(loginSchema, request.body, reply);
    if (!input) return;
    const row = context.users.findByUsername(input.username);
    const valid =
      row?.password_hash &&
      row.status === "active" &&
      (await verifyPassword(input.password, row.password_hash));
    if (!row || !valid) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }
    const user = context.users.sessionUser(row.id)!;
    createSession(reply, context, user.id);
    return { user };
  });

  app.get("/api/auth/session", async (request, reply) => {
    const user = currentUser(request, context);
    return user
      ? { authenticated: true, user }
      : reply.code(401).send({ authenticated: false });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    deleteSession(request, reply, context);
    return { ok: true };
  });
}

function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  reply: import("fastify").FastifyReply,
): T | undefined {
  const result = schema.safeParse(value);
  if (!result.success) {
    void reply.code(400).send({
      error: result.error.issues.map((issue) => issue.message).join("; "),
    });
    return undefined;
  }
  return result.data;
}
