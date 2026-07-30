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
  it("notifies every configured administrator channel once per failure", async () => {
    const enqueue = vi.fn();
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
      },
      { listChannels: () => channels },
      { listMembers: () => members },
      { enqueue },
    );

    await worker.tick();
    await worker.tick();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(
      enqueue.mock.calls.map(([message]) => message.providerInstanceId),
    ).toEqual(["wechat-main", "telegram-main"]);
  });

  it("does not notify for a local state read or an unrelated storage error", async () => {
    const enqueue = vi.fn();
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
      },
      { listChannels: () => channels },
      { listMembers: () => members },
      { enqueue },
    );

    await worker.tick();

    expect(enqueue).not.toHaveBeenCalled();
  });
});
