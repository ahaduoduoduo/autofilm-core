import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { hashPassword } from "../security/password.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const entry of apps.splice(0)) await entry.app.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function testApp() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "autofilm-core-"));
  directories.push(dataDir);
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 3100,
    dataDir,
    databasePath: path.join(dataDir, "test.sqlite"),
    publicUrl: "http://localhost:3100",
    mediaBaseUrl: "http://autofilm-core:3100",
    logLevel: "silent",
    masterKey: Buffer.alloc(32, 3).toString("base64"),
    adminUsername: undefined,
    adminPassword: undefined,
    bootstrapAi: undefined,
  };
  const built = await buildApp(config);
  apps.push(built);
  return built;
}

describe("authentication and administration routes", () => {
  it("requires one-time setup and creates an authenticated owner session", async () => {
    const { app } = await testApp();
    const before = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(before.json()).toEqual({ required: true });

    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: {
        username: "admin",
        displayName: "Owner",
        password: "a secure password 123",
      },
    });
    expect(setup.statusCode).toBe(200);
    const cookie = setup.cookies[0];
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");

    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      cookies: { autofilm_session: cookie!.value },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.role).toBe("owner");

    const repeated = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: {
        username: "other",
        displayName: "Other",
        password: "another secure password",
      },
    });
    expect(repeated.statusCode).toBe(409);
  });

  it("rejects unauthenticated administrator requests", async () => {
    const { app } = await testApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/members",
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("native message service route", () => {
  it("authenticates adapters and records new identities as pending", async () => {
    const { app, context } = await testApp();
    context.configs.saveChannel({
      name: "WeClaw",
      type: "native",
      providerInstanceId: "wechat-main",
      baseUrl: "http://weclaw:18011",
      inboundToken: "adapter-to-core-token-with-length",
      outboundToken: "core-to-adapter-token",
      enabled: true,
    });
    const event = {
      version: "2026-07-01",
      event_id: "wechat:wechat-main:1",
      event_type: "message.created",
      provider: "wechat",
      provider_instance_id: "wechat-main",
      conversation_id: "friend@im.wechat",
      sender_id: "friend@im.wechat",
      message_id: "1",
      message_type: "text",
      text: "想看一部电影",
      timestamp: new Date().toISOString(),
      capabilities: ["text"],
    };
    const denied = await app.inject({
      method: "POST",
      url: "/v1/conversation/events",
      headers: { authorization: "Bearer wrong-token" },
      payload: event,
    });
    expect(denied.statusCode).toBe(401);

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/conversation/events",
      headers: {
        authorization: "Bearer adapter-to-core-token-with-length",
      },
      payload: event,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().messages[0].text).toContain("尚未获得");
    expect(context.users.listIdentities()).toHaveLength(1);

    const repeated = await app.inject({
      method: "POST",
      url: "/v1/conversation/events",
      headers: {
        authorization: "Bearer adapter-to-core-token-with-length",
      },
      payload: event,
    });
    expect(repeated.body).toBe(accepted.body);
  });

  it("handles a reset event for an active bound identity without an AI call", async () => {
    const { app, context } = await testApp();
    context.configs.saveChannel({
      name: "WeClaw",
      type: "native",
      providerInstanceId: "wechat-main",
      baseUrl: "",
      inboundToken: "adapter-to-core-token-with-length",
      enabled: true,
    });
    const member = context.users.create({
      username: "friend",
      displayName: "Friend",
      passwordHash: await hashPassword("friend secure password"),
      role: "member",
    });
    const identity = context.users.ensurePendingIdentity({
      channel: "wechat",
      providerInstanceId: "wechat-main",
      externalUserId: "friend@im.wechat",
      displayName: "Friend",
    });
    context.users.bindIdentity(identity.id, member.id, "active");
    const response = await app.inject({
      method: "POST",
      url: "/v1/conversation/events",
      headers: {
        authorization: "Bearer adapter-to-core-token-with-length",
      },
      payload: {
        version: "2026-07-01",
        event_id: "reset:wechat-main:1",
        event_type: "conversation.reset",
        provider: "wechat",
        provider_instance_id: "wechat-main",
        conversation_id: "friend@im.wechat",
        sender_id: "friend@im.wechat",
        message_id: "",
        message_type: "control",
        timestamp: new Date().toISOString(),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages[0].text).toContain("已清除");
  });
});
