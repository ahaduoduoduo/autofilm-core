import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { TaskStore } from "../db/task-store.js";
import { ProgressWorker } from "./progress-worker.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function testTasks() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-submit-"));
  directories.push(directory);
  const database = openDatabase(path.join(directory, "test.sqlite"));
  return { database, tasks: new TaskStore(database) };
}

describe("OpenList provider submission timing", () => {
  it("does not start the 40-second timeout before 115 accepts the task", async () => {
    const { database, tasks } = testTasks();
    const deleted: string[] = [];
    const local = tasks.create({
      type: "offline-download",
      title: "Still submitting",
      state: "running",
      externalId: "openlist-local-task",
      metadata: {
        attemptQueuedAt: new Date(0).toISOString(),
        instantOfflinePolicy: { enabled: true, timeoutMs: 1_000 },
      },
    });
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [{
            id: "openlist-local-task",
            name: "Still submitting",
            state: 1,
            status: "running",
            progress: 0,
            total_bytes: 0,
            error: "",
          }];
        },
        async deleteOfflineTask(taskId) {
          deleted.push(taskId);
        },
      },
      tasks,
    );

    await worker.tick();

    expect(deleted).toEqual([]);
    expect(tasks.get(local.id)?.state).toBe("running");
    expect(tasks.get(local.id)?.statusText).toBe("正在等待 115 接受任务");
    expect(tasks.get(local.id)?.metadata.attemptStartedAt).toBeUndefined();
    database.close();
  });

  it("records an unconfirmed submission failure separately", async () => {
    const { database, tasks } = testTasks();
    const deleted: string[] = [];
    const local = tasks.create({
      type: "offline-download",
      title: "Missing local task",
      state: "running",
      externalId: "missing-openlist-task",
      metadata: {
        downloadCandidates: [{
          id: "only",
          title: "Only release",
          magnetUri: `magnet:?xt=urn:btih:${"d".repeat(40)}`,
        }],
        attemptQueuedAt: new Date(0).toISOString(),
        instantOfflinePolicy: { enabled: true, timeoutMs: 1_000 },
      },
    });
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [];
        },
        async deleteOfflineTask(taskId) {
          deleted.push(taskId);
        },
      },
      tasks,
    );

    await worker.tick();

    expect(deleted).toEqual(["missing-openlist-task"]);
    expect(tasks.get(local.id)?.state).toBe("failed");
    expect(tasks.get(local.id)?.statusText).toContain("115 未确认接受该资源");
    expect(tasks.get(local.id)?.metadata.providerTaskId).toBeUndefined();
    database.close();
  });
});
