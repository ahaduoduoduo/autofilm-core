import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import { hashPassword } from "../security/password.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const entry of apps.splice(0)) await entry.app.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function testApp(overrides: Partial<AppConfig> = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "autofilm-core-"));
  directories.push(dataDir);
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 3100,
    dataDir,
    databasePath: path.join(dataDir, "test.sqlite"),
    publicUrl: "http://localhost:3100",
    mediaBaseUrl: "http://autofilm-core:3100",
    telegramAdapterUrl: "http://telegram-adapter:18012",
    weClawDataDir: undefined,
    weClawUrl: "http://weclaw:18011",
    logLevel: "silent",
    masterKey: Buffer.alloc(32, 3).toString("base64"),
    adminUsername: undefined,
    adminPassword: undefined,
    bootstrapAi: undefined,
    watchlistIntervalMs: 21_600_000,
    ...overrides,
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

  it("configures Telegram through the internal adapter without exposing service tokens", async () => {
    const { app, context } = await testApp();
    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: {
        username: "telegram-admin",
        displayName: "Telegram Admin",
        password: "a secure password 123",
      },
    });
    const sessionCookie = setup.cookies[0]!.value;
    let adapterPayload: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        adapterPayload = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            configured: true,
            bot_id: 123,
            bot_username: "autofilm_test_bot",
            bot_name: "AutoFilm Test",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/channels/telegram/setup",
      cookies: { autofilm_session: sessionCookie },
      payload: {
        botToken: "123456789:telegram-test-token",
        enabled: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().bot.bot_username).toBe("autofilm_test_bot");
    expect(adapterPayload?.botToken).toBe("123456789:telegram-test-token");
    expect(adapterPayload?.coreToken).not.toBe(adapterPayload?.outboundToken);
    const channel = context.configs.listChannels()[0];
    expect(channel?.providerInstanceId).toBe("telegram-main");
    expect(channel?.hasInboundToken).toBe(true);
    expect(channel?.hasOutboundToken).toBe(true);
  });

  it("lists, edits, and resets database-backed prompts", async () => {
    const { app } = await testApp();
    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: {
        username: "prompt-admin",
        displayName: "Prompt Admin",
        password: "a secure password 123",
      },
    });
    const cookies = { autofilm_session: setup.cookies[0]!.value };
    const initial = await app.inject({
      method: "GET",
      url: "/api/admin/prompts",
      cookies,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toHaveLength(5);
    expect(initial.json()[0].key).toBe("agent.main");
    expect(initial.json()[0].content).toContain("资源评估");
    expect(initial.json()[0].customized).toBe(false);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/admin/prompts/agent.main",
      cookies,
      payload: { content: "自定义主提示词" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().customized).toBe(true);
    expect(updated.json().content).toBe("自定义主提示词");

    const reset = await app.inject({
      method: "POST",
      url: "/api/admin/prompts/agent.main/reset",
      cookies,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().customized).toBe(false);
    expect(reset.json().content).toContain("资源评估");
  });

  it("automatically registers logged-in WeClaw accounts without exposing tokens", async () => {
    const weClawDataDir = mkdtempSync(path.join(os.tmpdir(), "autofilm-weclaw-"));
    directories.push(weClawDataDir);
    mkdirSync(path.join(weClawDataDir, "accounts"));
    writeFileSync(
      path.join(weClawDataDir, "config.json"),
      JSON.stringify({
        agents: {
          autofilm: {
            type: "native",
            api_key: "weclaw-to-core-token-with-length",
            outbound_token: "core-to-weclaw-token",
          },
        },
      }),
    );
    writeFileSync(
      path.join(weClawDataDir, "accounts", "account.json"),
      JSON.stringify({ ilink_bot_id: "bot-account@im.bot" }),
    );

    const { app, context } = await testApp({ weClawDataDir });
    const channel = context.configs.listChannels()[0];
    expect(channel?.providerInstanceId).toBe("bot-account@im.bot");
    expect(channel?.baseUrl).toBe("http://weclaw:18011");
    expect(channel?.hasInboundToken).toBe(true);
    expect(channel?.hasOutboundToken).toBe(true);

    const setup = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: {
        username: "weclaw-admin",
        displayName: "WeClaw Admin",
        password: "a secure password 123",
      },
    });
    const status = await app.inject({
      method: "GET",
      url: "/api/admin/channels/weclaw/status",
      cookies: { autofilm_session: setup.cookies[0]!.value },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      available: true,
      configReady: true,
      accounts: [
        {
          providerInstanceId: "bot-account@im.bot",
          configured: true,
          enabled: true,
        },
      ],
    });
    expect(status.body).not.toContain("weclaw-to-core-token");
    expect(status.body).not.toContain("core-to-weclaw-token");
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
