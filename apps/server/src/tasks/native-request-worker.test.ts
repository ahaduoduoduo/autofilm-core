import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/database.js";
import { NativeRequestStore } from "../db/native-request-store.js";
import { OutboxStore } from "../db/outbox-store.js";
import { UserStore } from "../db/user-store.js";
import { NativeRequestWorker } from "./native-request-worker.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("native request worker", () => {
  it("runs an accepted request and queues its final response", async () => {
    const setup = createSetup();
    setup.requests.enqueue(requestInput(setup.userId, "event-success"));
    const respond = vi.fn(async () => "字幕已经转换完成。");
    const worker = new NativeRequestWorker(
      setup.database,
      setup.requests,
      { respond, reset: vi.fn() },
      setup.outbox,
      "https://af.example.test",
    );

    worker.tick();
    await vi.waitFor(() => {
      expect(setup.requests.get("event-success")?.state).toBe("completed");
    });

    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "处理字幕",
        externalConversationId: "member@wechat",
      }),
    );
    expect(setup.outbox.claimDue()[0]?.payload.messages).toEqual([
      { type: "text", text: "字幕已经转换完成。" },
    ]);
    setup.database.close();
  });

  it("queues a failure response after agent retries are exhausted", async () => {
    const setup = createSetup();
    setup.requests.enqueue(requestInput(setup.userId, "event-failed"));
    const worker = new NativeRequestWorker(
      setup.database,
      setup.requests,
      {
        respond: vi.fn(async () => {
          throw new Error("provider unavailable");
        }),
        reset: vi.fn(),
      },
      setup.outbox,
      "https://af.example.test",
    );

    worker.tick();
    await vi.waitFor(() => {
      expect(setup.requests.get("event-failed")?.state).toBe("failed");
    });

    expect(setup.outbox.claimDue()[0]?.payload.messages[0]).toEqual({
      type: "text",
      text: "请求处理失败：provider unavailable",
    });
    setup.database.close();
  });

  it("reports interrupted work at startup without executing it again", () => {
    const setup = createSetup();
    setup.requests.enqueue(requestInput(setup.userId, "event-restarted"));
    setup.requests.claimPending(1);
    const respond = vi.fn();
    const worker = new NativeRequestWorker(
      setup.database,
      setup.requests,
      { respond, reset: vi.fn() },
      setup.outbox,
      "https://af.example.test",
      60_000,
    );

    worker.start();
    worker.stop();

    expect(respond).not.toHaveBeenCalled();
    expect(setup.requests.get("event-restarted")?.state).toBe("failed");
    expect(setup.outbox.claimDue()[0]?.payload.messages[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Core 服务重启而中断"),
    });
    setup.database.close();
  });
});

function createSetup() {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "autofilm-native-worker-"),
  );
  directories.push(directory);
  const database = openDatabase(path.join(directory, "test.sqlite"));
  const userId = new UserStore(database).create({
    username: `worker-${directories.length}`,
    displayName: "Worker Member",
    role: "member",
  }).id;
  return {
    database,
    requests: new NativeRequestStore(database),
    outbox: new OutboxStore(database),
    userId,
  };
}

function requestInput(userId: string, eventId: string) {
  return {
    eventId,
    userId,
    channel: "wechat",
    providerInstanceId: "wechat-main",
    externalConversationId: "member@wechat",
    eventType: "message.created" as const,
    text: "处理字幕",
  };
}
