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
        async deleteOfflineTask() {},
        async startOfflineDownload() {
          return [];
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
        async deleteOfflineTask() {},
        async startOfflineDownload() {
          return [];
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

  it("does not complete or refresh a 100 percent task without an end time", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const outbox = new OutboxStore(database);
    const local = tasks.create({
      type: "offline-download",
      title: "Still finalizing",
      state: "running",
      externalId: "remote-finalizing",
      metadata: {
        destination: "/115/Movies/Still Finalizing",
      },
    });
    const refreshes: string[] = [];
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [
            {
              id: "remote-finalizing",
              name: "Still finalizing",
              state: 1,
              status: "[115 Cloud]: 离线任务下载中",
              progress: 100,
              total_bytes: 2048,
              error: "",
            },
          ];
        },
        async deleteOfflineTask() {},
        async startOfflineDownload() {
          return [];
        },
      },
      tasks,
      15_000,
      outbox,
      {
        async remoteRefresh(input) {
          refreshes.push(input.path);
        },
      },
    );

    await worker.tick();

    expect(tasks.get(local.id)?.state).toBe("running");
    expect(tasks.get(local.id)?.progress).toBe(100);
    expect(outbox.claimDue()).toHaveLength(0);
    expect(refreshes).toHaveLength(0);
    database.close();
  });

  it("refreshes the exact provider result path after completion", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const destination = "/115/nvideo/movie/2026-07";
    const resultPath =
      "/115/nvideo/movie/2026-07/Colony (2026) WEB-DL 1080p.mkv";
    const local = tasks.create({
      type: "offline-download",
      title: "Colony",
      state: "running",
      externalId: "remote-colony",
      metadata: {
        destination,
        jellyfinRefreshPath: destination,
      },
    });
    const refreshes: string[] = [];
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [
            {
              id: "remote-colony",
              name: "Colony",
              state: 2,
              status: "succeeded",
              progress: 100,
              total_bytes: 2048,
              error: "",
              result_path: resultPath,
              end_time: new Date().toISOString(),
            },
          ];
        },
        async deleteOfflineTask() {},
        async startOfflineDownload() {
          return [];
        },
      },
      tasks,
      15_000,
      undefined,
      {
        async remoteRefresh(input) {
          refreshes.push(input.path);
        },
      },
    );

    await worker.tick();

    expect(refreshes).toEqual([resultPath]);
    expect(tasks.get(local.id)?.metadata.remoteResultPath).toBe(resultPath);
    database.close();
  });

  it("does not regress a completed task when a stale running snapshot arrives", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const local = tasks.create({
      type: "offline-download",
      title: "Already completed",
      state: "completed",
      externalId: "remote-completed",
    });
    tasks.update(local.id, { statusText: "succeeded" });
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [
            {
              id: "remote-completed",
              name: "Already completed",
              state: 1,
              status: "downloading",
              progress: 99,
              total_bytes: 2048,
              error: "",
            },
          ];
        },
        async deleteOfflineTask() {},
        async startOfflineDownload() {
          return [];
        },
      },
      tasks,
    );

    await worker.tick();

    expect(tasks.get(local.id)?.state).toBe("completed");
    expect(tasks.get(local.id)?.statusText).toBe("succeeded");
    database.close();
  });

  it("groups completed downloads by destination and refreshes Jellyfin once", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const destination = "/115/Shows/Example/Season 01";
    const refreshPath = "/115/Shows/Example";
    const metadata = {
      destination,
      jellyfinRefreshPath: refreshPath,
      jellyfinProviderIds: { Tmdb: "123" },
    };
    const first = tasks.create({
      type: "offline-download",
      title: "Episode 1",
      state: "running",
      externalId: "remote-episode-1",
      metadata,
    });
    const second = tasks.create({
      type: "offline-download",
      title: "Episode 2",
      state: "running",
      externalId: "remote-episode-2",
      metadata,
    });
    const refreshes: Array<Record<string, unknown>> = [];
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return ["remote-episode-1", "remote-episode-2"].map((id) => ({
            id,
            name: id,
            state: 2,
            status: "succeeded",
            progress: 100,
            total_bytes: 2048,
            error: "",
            end_time: new Date().toISOString(),
          }));
        },
        async deleteOfflineTask() {},
        async startOfflineDownload() {
          return [];
        },
      },
      tasks,
      2_000,
      undefined,
      {
        async remoteRefresh(input) {
          refreshes.push(input);
        },
      },
    );

    await worker.tick();

    expect(refreshes).toEqual([
      {
        path: refreshPath,
        recursive: true,
        refresh: true,
        forceProbe: false,
        providerIds: { Tmdb: "123" },
      },
    ]);
    expect(
      (tasks.get(first.id)?.metadata.jellyfinRefresh as { state: string }).state,
    ).toBe("completed");
    expect(
      (tasks.get(second.id)?.metadata.jellyfinRefresh as { state: string })
        .state,
    ).toBe("completed");
    database.close();
  });

  it("retries a pending Jellyfin refresh while OpenList is unavailable", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const destination = "/115/Movies/Already Completed";
    const local = tasks.create({
      type: "offline-download",
      title: "Already completed",
      state: "completed",
      metadata: {
        destination,
        jellyfinRefresh: {
          state: "pending",
          path: destination,
          attempts: 1,
          nextAttemptAt: new Date(0).toISOString(),
        },
      },
    });
    const refreshes: string[] = [];
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          throw new Error("OpenList unavailable");
        },
        async deleteOfflineTask() {},
        async startOfflineDownload() {
          return [];
        },
      },
      tasks,
      2_000,
      undefined,
      {
        async remoteRefresh(input) {
          refreshes.push(input.path);
        },
      },
    );

    await worker.tick();

    expect(refreshes).toEqual([destination]);
    expect(
      (tasks.get(local.id)?.metadata.jellyfinRefresh as { state: string }).state,
    ).toBe("completed");
    database.close();
  });

  it("deletes a timed-out 115 task and submits the next magnet candidate", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const deleted: string[] = [];
    const submitted: string[] = [];
    const local = tasks.create({
      type: "offline-download",
      title: "Instant transfer",
      state: "running",
      externalId: "remote-old",
      metadata: {
        destination: "/115/Movies/Example",
        sourceUrl: "magnet:?xt=urn:btih:first",
        candidateUrls: [
          "magnet:?xt=urn:btih:first",
          "magnet:?xt=urn:btih:second",
        ],
        attemptIndex: 0,
        attemptStartedAt: new Date(0).toISOString(),
        instantOfflinePolicy: { enabled: true, timeoutMs: 1_000 },
      },
    });
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [
            {
              id: "remote-old",
              name: "First",
              state: 1,
              status: "downloading",
              progress: 0,
              total_bytes: 0,
              error: "",
            },
          ];
        },
        async deleteOfflineTask(taskId) {
          deleted.push(taskId);
        },
        async startOfflineDownload(input) {
          submitted.push(input.url);
          return [
            {
              id: "remote-next",
              name: "Second",
              state: 1,
              status: "pending",
              progress: 0,
              total_bytes: 0,
              error: "",
            },
          ];
        },
      },
      tasks,
    );
    await worker.tick();
    expect(deleted).toEqual(["remote-old"]);
    expect(submitted).toEqual(["magnet:?xt=urn:btih:second"]);
    expect(tasks.get(local.id)?.externalId).toBe("remote-next");
    expect(tasks.get(local.id)?.metadata.attemptIndex).toBe(1);
    expect(tasks.get(local.id)?.state).toBe("running");
    database.close();
  });

  it("fails and notifies when a timed-out task has no fallback magnet", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const outbox = new OutboxStore(database);
    const users = new UserStore(database);
    const member = users.create({
      username: "retry-member",
      displayName: "Retry Member",
      role: "member",
    });
    const local = tasks.create({
      userId: member.id,
      type: "offline-download",
      title: "No fallback",
      state: "running",
      externalId: "remote-only",
      metadata: {
        destination: "/115/Movies/Example",
        sourceUrl: "magnet:?xt=urn:btih:only",
        candidateUrls: ["magnet:?xt=urn:btih:only"],
        attemptIndex: 0,
        attemptStartedAt: new Date(0).toISOString(),
        instantOfflinePolicy: { enabled: true, timeoutMs: 1_000 },
      },
    });
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [];
        },
        async deleteOfflineTask() {},
        async startOfflineDownload() {
          return [];
        },
      },
      tasks,
      2_000,
      outbox,
    );
    await worker.tick();
    expect(tasks.get(local.id)?.state).toBe("failed");
    expect(tasks.get(local.id)?.statusText).toContain("没有可用的备用磁力");
    expect(outbox.claimDue()).toHaveLength(1);
    database.close();
  });
});
