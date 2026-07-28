import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { TaskStore } from "../db/task-store.js";
import { OutboxStore } from "../db/outbox-store.js";
import { UserStore } from "../db/user-store.js";
import { ProgressWorker } from "./progress-worker.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenList task progress worker", () => {
  it("updates only the local task that has the matching in-memory task id", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const local = tasks.create({
      type: "offline-download",
      title: "Example",
      state: "running",
      externalId: "remote-1",
    });
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [
            {
              id: "remote-1",
              name: "Example",
              state: 1,
              status: "downloading",
              progress: 48.5,
              total_bytes: 1024,
              error: "",
            },
          ];
        },
      },
      tasks,
    );
    await worker.tick();
    expect(tasks.get(local.id)?.progress).toBe(48.5);
    expect(tasks.get(local.id)?.statusText).toBe("downloading");
    database.close();
  });

  it("queues one member notification when a task becomes terminal", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const outbox = new OutboxStore(database);
    const users = new UserStore(database);
    const member = users.create({
      username: "member",
      displayName: "Member",
      role: "member",
    });
    const local = tasks.create({
      userId: member.id,
      type: "offline-download",
      title: "Completed example",
      state: "running",
      externalId: "remote-2",
    });
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [
            {
              id: "remote-2",
              name: "Completed example",
              state: 2,
              status: "succeeded",
              progress: 100,
              total_bytes: 2048,
              error: "",
              end_time: new Date().toISOString(),
            },
          ];
        },
      },
      tasks,
      15_000,
      outbox,
    );
    await worker.tick();
    expect(tasks.get(local.id)?.state).toBe("completed");
    const messages = outbox.claimDue();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload.messages[0]?.text).toContain("已完成");
    database.close();
  });
});
