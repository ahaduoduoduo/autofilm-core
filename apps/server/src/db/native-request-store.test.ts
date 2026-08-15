import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { NativeRequestStore } from "./native-request-store.js";
import { UserStore } from "./user-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("native request store", () => {
  it("enqueues each adapter event once and records completion", () => {
    const { database, requests, userId } = setup();
    const input = requestInput(userId, "event-1");

    expect(requests.enqueue(input)).toBe(true);
    expect(requests.enqueue(input)).toBe(false);
    expect(requests.claimPending(4)).toHaveLength(1);
    expect(requests.get("event-1")?.state).toBe("running");

    requests.markCompleted("event-1");
    expect(requests.get("event-1")).toMatchObject({
      state: "completed",
      lastError: "",
    });
    expect(
      (
        database
          .prepare("SELECT COUNT(*) AS total FROM native_request_jobs")
          .get() as { total: number }
      ).total,
    ).toBe(1);
    database.close();
  });

  it("marks interrupted requests failed instead of replaying them", () => {
    const { database, requests, userId } = setup();
    requests.enqueue(requestInput(userId, "event-interrupted"));
    requests.claimPending(1);

    const recovered = requests.recoverInterrupted();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      eventId: "event-interrupted",
      state: "failed",
    });
    expect(requests.claimPending(1)).toEqual([]);
    database.close();
  });
});

function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-native-"));
  directories.push(directory);
  const database = openDatabase(path.join(directory, "test.sqlite"));
  const userId = new UserStore(database).create({
    username: `native-${directories.length}`,
    displayName: "Native Member",
    role: "member",
  }).id;
  return {
    database,
    requests: new NativeRequestStore(database),
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
