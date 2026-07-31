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
              provider_task_id: "provider-1",
              provider_submitted_at: new Date().toISOString(),
            },
          ];
        },
        async deleteOfflineTask() {},
      },
      tasks,
    );
    await worker.tick();
    expect(tasks.get(local.id)?.progress).toBe(48.5);
    expect(tasks.get(local.id)?.statusText).toBe("downloading");
    database.close();
  });

  it("defers the success notification until Jellyfin completion processing", async () => {
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
      },
      tasks,
      15_000,
      outbox,
    );
    await worker.tick();
    expect(tasks.get(local.id)?.state).toBe("completed");
    expect(outbox.claimDue()).toHaveLength(0);
    database.close();
  });

  it("maps explicit OpenList canceled and failed terminal states", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const canceled = tasks.create({
      type: "offline-download",
      title: "Canceled",
      state: "running",
      externalId: "remote-canceled",
    });
    const failed = tasks.create({
      type: "offline-download",
      title: "Failed",
      state: "running",
      externalId: "remote-failed",
    });
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [
            {
              id: "remote-canceled",
              name: "Canceled",
              state: 4,
              status: "已取消",
              progress: 20,
              total_bytes: 1024,
              error: "",
            },
            {
              id: "remote-failed",
              name: "Failed",
              state: 7,
              status: "失败",
              progress: 40,
              total_bytes: 1024,
              error: "",
            },
          ];
        },
        async deleteOfflineTask() {},
      },
      tasks,
    );

    await worker.tick();

    expect(tasks.get(canceled.id)?.state).toBe("cancelled");
    expect(tasks.get(failed.id)?.state).toBe("failed");
    database.close();
  });

  it("does not complete or refresh a non-succeeded task with progress and end time", async () => {
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
              end_time: new Date().toISOString(),
            },
          ];
        },
        async deleteOfflineTask() {},
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
        jellyfinProviderIds: { Tmdb: "1375646" },
        media: { type: "movie", tmdbId: 1375646 },
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
    expect(
      tasks.get(local.id)?.metadata.jellyfinRefresh,
    ).toMatchObject({
      providerIds: { Tmdb: "1375646" },
      providerTarget: "movie",
    });
    database.close();
  });

  it("leaves media upgrades for the replacement worker without a library refresh", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const resultPath = "/115/autofilm-staging/upgrades/item-1/new.mkv";
    const local = tasks.create({
      type: "offline-download",
      title: "Upgrade",
      state: "running",
      externalId: "remote-upgrade",
      metadata: {
        destination: "/115/autofilm-staging/upgrades/item-1",
        mediaUpgrade: {
          jobId: "job-1",
          upgradeItemId: "item-1",
          jellyfinItemId: "movie-1",
        },
      },
    });
    const refreshes: string[] = [];
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [
            {
              id: "remote-upgrade",
              name: "Upgrade",
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

    expect(tasks.get(local.id)?.state).toBe("completed");
    expect(tasks.get(local.id)?.metadata.remoteResultPath).toBe(resultPath);
    expect(tasks.get(local.id)?.metadata.jellyfinRefresh).toBeUndefined();
    expect(refreshes).toEqual([]);
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

  it("deletes a timed-out task and waits for the user to choose a fallback", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-task-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const outbox = new OutboxStore(database);
    const users = new UserStore(database);
    const member = users.create({
      username: "fallback-member",
      displayName: "Fallback Member",
      role: "member",
    });
    const deleted: string[] = [];
    const local = tasks.create({
      userId: member.id,
      type: "offline-download",
      title: "Instant transfer",
      state: "running",
      externalId: "remote-old",
      metadata: {
        destination: "/115/Movies/Example",
        downloadCandidates: [
          {
            id: "first",
            title: "Example.2160p.First",
            magnetUri: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
          },
          {
            id: "second",
            title: "Example.2160p.Second",
            magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
          },
        ],
        attemptIndex: 0,
        attemptStartedAt: new Date(0).toISOString(),
        instantOfflinePolicy: { enabled: true, timeoutMs: 1_000 },
        notificationTarget: {
          channel: "wechat",
          providerInstanceId: "wechat-main",
          targetId: "member@wechat",
        },
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
              provider_task_id: "provider-first",
              provider_submitted_at: new Date(0).toISOString(),
            },
          ];
        },
        async deleteOfflineTask(taskId) {
          deleted.push(taskId);
        },
      },
      tasks,
      2_000,
      outbox,
    );
    await worker.tick();
    expect(deleted).toEqual(["remote-old"]);
    expect(tasks.get(local.id)?.externalId).toBeNull();
    expect(tasks.get(local.id)?.metadata.attemptIndex).toBe(0);
    expect(tasks.get(local.id)?.metadata.awaitingFallbackSelection).toBe(true);
    expect(tasks.get(local.id)?.state).toBe("waiting");
    expect(tasks.get(local.id)?.metadata.providerTaskId).toBe(
      "provider-first",
    );
    const attempts = tasks.get(local.id)?.metadata.attempts as Array<
      Record<string, unknown>
    >;
    expect(attempts[0]).toMatchObject({
      openListTaskId: "remote-old",
      providerTaskId: "provider-first",
      providerSubmittedAt: new Date(0).toISOString(),
    });
    const messages = outbox.claimDue();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload.messages[0]?.text).toContain(
      "未确认前不会下载备用资源",
    );
    expect(messages[0]?.payload.messages[0]?.text).toContain(
      "Example.2160p.Second",
    );
    expect(messages[0]?.payload.messages[0]?.text).not.toContain("magnet:");
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
        downloadCandidates: [{
          id: "only",
          title: "Only Release",
          magnetUri: `magnet:?xt=urn:btih:${"c".repeat(40)}`,
        }],
        attemptIndex: 0,
        providerTaskId: "provider-only",
        providerSubmittedAt: new Date(0).toISOString(),
        instantOfflinePolicy: { enabled: true, timeoutMs: 1_000 },
      },
    });
    const worker = new ProgressWorker(
      {
        async listOfflineTasks() {
          return [];
        },
        async deleteOfflineTask() {},
      },
      tasks,
      2_000,
      outbox,
    );
    await worker.tick();
    expect(tasks.get(local.id)?.state).toBe("failed");
    expect(tasks.get(local.id)?.statusText).toContain(
      "没有尚未尝试的备用资源",
    );
    expect(outbox.claimDue()).toHaveLength(1);
    database.close();
  });
});
