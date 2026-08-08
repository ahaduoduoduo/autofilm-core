import { describe, expect, it, vi } from "vitest";
import { OpenListAuthWorker } from "./openlist-auth-worker.js";

const channels = [
  {
    id: "channel-1",
    name: "WeChat",
    type: "native" as const,
    providerInstanceId: "wechat-main",
    baseUrl: "http://weclaw:18011",
    enabled: true,
    hasInboundToken: true,
    hasOutboundToken: true,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "channel-2",
    name: "Telegram",
    type: "native" as const,
    providerInstanceId: "telegram-main",
    baseUrl: "http://telegram-adapter:18012",
    enabled: true,
    hasInboundToken: true,
    hasOutboundToken: true,
    createdAt: "",
    updatedAt: "",
  },
];

const members = [
  {
    id: "owner",
    username: "owner",
    displayName: "Owner",
    role: "owner" as const,
    status: "active" as const,
    createdAt: "",
    updatedAt: "",
    identities: [
      {
        id: "wechat-id",
        userId: "owner",
        channel: "wechat",
        providerInstanceId: "wechat-main",
        externalUserId: "wx-user",
        displayName: "Owner",
        status: "active" as const,
        createdAt: "",
      },
      {
        id: "telegram-id",
        userId: "owner",
        channel: "telegram",
        providerInstanceId: "telegram-main",
        externalUserId: "tg-user",
        displayName: "Owner",
        status: "active" as const,
        createdAt: "",
      },
    ],
  },
];

describe("OpenList authentication worker", () => {
  it("sends one shared QR session to every administrator channel", async () => {
    const enqueueMessages = vi.fn();
    const startAuth = vi.fn(async () => ({
      session_id: "auth-session",
      state: "pending",
      expires_at: "2026-08-09T04:00:00.000Z",
    }));
    const authQrCode = vi.fn(async () => Buffer.from("png"));
    const create = vi.fn(() => "media-token");
    const worker = new OpenListAuthWorker(
      {
        async authState() {
          return {
            authenticated: false,
            state: "risk_controlled" as const,
            requires_reauthentication: true,
            status_code: 405,
            message: "HTTP 405",
          };
        },
        authStorageId: () => 1,
        startAuth,
        authQrCode,
      },
      { listChannels: () => channels },
      { listMembers: () => members },
      { enqueueMessages },
      { create },
      "http://autofilm-core:3100",
    );

    await worker.tick();
    await worker.tick();

    expect(startAuth).toHaveBeenCalledOnce();
    expect(authQrCode).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(enqueueMessages).toHaveBeenCalledTimes(2);
    expect(
      enqueueMessages.mock.calls.map(
        ([message]) => message.providerInstanceId,
      ),
    ).toEqual(["wechat-main", "telegram-main"]);
    for (const [message] of enqueueMessages.mock.calls) {
      expect(message.messages).toEqual([
        expect.objectContaining({ type: "text" }),
        {
          type: "image",
          media_url: "http://autofilm-core:3100/v1/media/media-token",
          file_name: "openlist-115-auth.png",
        },
      ]);
    }
  });

  it("does not notify for a local state read or an unrelated storage error", async () => {
    const enqueueMessages = vi.fn();
    const worker = new OpenListAuthWorker(
      {
        async authState() {
          return {
            authenticated: false,
            state: "error" as const,
            requires_reauthentication: false,
            message: "storage is initializing",
          };
        },
        authStorageId: () => 1,
        startAuth: vi.fn(),
        authQrCode: vi.fn(),
      },
      { listChannels: () => channels },
      { listMembers: () => members },
      { enqueueMessages },
      { create: vi.fn() },
      "http://autofilm-core:3100",
    );

    await worker.tick();

    expect(enqueueMessages).not.toHaveBeenCalled();
  });

  it("falls back to one actionable text when QR creation fails", async () => {
    const enqueueMessages = vi.fn();
    const worker = new OpenListAuthWorker(
      {
        async authState() {
          return {
            authenticated: false,
            state: "risk_controlled" as const,
            requires_reauthentication: true,
            status_code: 405,
            message: "HTTP 405",
          };
        },
        authStorageId: () => 1,
        startAuth: vi.fn(async () => {
          throw new Error("auth service unavailable");
        }),
        authQrCode: vi.fn(),
      },
      { listChannels: () => channels },
      { listMembers: () => members },
      { enqueueMessages },
      { create: vi.fn() },
      "http://autofilm-core:3100",
    );

    await worker.tick();

    expect(enqueueMessages).toHaveBeenCalledTimes(2);
    expect(enqueueMessages.mock.calls[0]?.[0].messages).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("自动生成二维码失败"),
      }),
    ]);
  });
});
