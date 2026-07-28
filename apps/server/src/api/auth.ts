import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionUser } from "@autofilm/contracts";
import type { AppContext } from "../app-context.js";
import { createToken, hashToken } from "../security/tokens.js";

const COOKIE_NAME = "autofilm_session";
const SESSION_DAYS = 30;

export function currentUser(
  request: FastifyRequest,
  context: AppContext,
): SessionUser | undefined {
  const token = request.cookies[COOKIE_NAME];
  return token ? context.users.resolveSession(hashToken(token)) : undefined;
}

export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  context: AppContext,
): Promise<SessionUser | undefined> {
  const user = currentUser(request, context);
  if (!user) {
    await reply.code(401).send({ error: "Authentication required" });
    return undefined;
  }
  return user;
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  context: AppContext,
): Promise<SessionUser | undefined> {
  const user = await requireUser(request, reply, context);
  if (!user) return undefined;
  if (user.role !== "owner" && user.role !== "admin") {
    await reply.code(403).send({ error: "Administrator role required" });
    return undefined;
  }
  return user;
}

export function createSession(
  reply: FastifyReply,
  context: AppContext,
  userId: string,
): void {
  const token = createToken();
  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  );
  context.users.createSession(userId, hashToken(token), expiresAt.toISOString());
  reply.setCookie(COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: context.config.publicUrl.startsWith("https://"),
    expires: expiresAt,
  });
}

export function deleteSession(
  request: FastifyRequest,
  reply: FastifyReply,
  context: AppContext,
): void {
  const token = request.cookies[COOKIE_NAME];
  if (token) context.users.deleteSession(hashToken(token));
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}
