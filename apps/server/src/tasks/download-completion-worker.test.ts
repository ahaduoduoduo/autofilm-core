import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "../agent/service.js";
import { openDatabase } from "../db/database.js";
import { OutboxStore } from "../db/outbox-store.js";
import { TaskStore } from "../db/task-store.js";
import { UserStore } from "../db/user-store.js";
import { DownloadCompletionWorker } from "./download-completion-worker.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("download completion worker", () => {
  it("continues the original conversation only after every Jellyfin refresh completes", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "autofilm-completion-"),
    );
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const outbox = new OutboxStore(database);
    const users = new UserStore(database);
    const member = users.create({
      username: "completion-member",
      displayName: "Completion Member",
      role: "member",
    });
    const continuation = {
      workflowId: "workflow-1",
      state: "pending",
      attempts: 0,
      nextAttemptAt: new Date(0).toISOString(),
    };
    const notificationTarget = {
      channel: "wechat",
      providerInstanceId: "wechat-main",
      targetId: "member@wechat",
    };
    const first = tasks.create({
      userId: member.id,
      type: "offline-download",
      title: "Episode 1",
      state: "completed",
      metadata: {
        completionContinuation: continuation,
        notificationTarget,
        jellyfinRefresh: {
          state: "completed",
          path: "/115/Shows/Example/Season 01/Episode 1.mkv",
          attempts: 0,
          nextAttemptAt: new Date(0).toISOString(),
        },
      },
    });
    const second = tasks.create({
      userId: member.id,
      type: "offline-download",
      title: "Episode 2",
      state: "completed",
      metadata: {
        completionContinuation: continuation,
        notificationTarget,
        jellyfinRefresh: {
          state: "pending",
          path: "/115/Shows/Example/Season 01/Episode 2.mkv",
          attempts: 0,
          nextAttemptAt: new Date(0).toISOString(),
        },
      },
    });
    const calls: Array<Record<string, string>> = [];
    const agent = {
      async respond(input: Record<string, string>) {
        calls.push(input);
        return "视频已经入库；此前没有字幕计划，因此未添加外挂字幕。";
      },
    } as unknown as AgentService;
    const worker = new DownloadCompletionWorker(
      tasks,
      agent,
      outbox,
      "https://af.example.test",
    );

    await worker.tick();
    expect(calls).toHaveLength(0);
    expect(outbox.claimDue()).toHaveLength(0);

    tasks.update(second.id, {
      metadata: {
        ...tasks.get(second.id)!.metadata,
        jellyfinRefresh: {
          state: "completed",
          path: "/115/Shows/Example/Season 01/Episode 2.mkv",
          attempts: 0,
          nextAttemptAt: new Date(0).toISOString(),
        },
      },
    });
    await worker.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      userId: member.id,
      channel: "wechat",
      providerInstanceId: "wechat-main",
      externalConversationId: "member@wechat",
    });
    expect(calls[0]?.text).toContain("Jellyfin 已完成入库");
    expect(calls[0]?.text).toContain("没有满意字幕");
    expect(outbox.claimDue()[0]?.payload.messages).toEqual([
      {
        type: "text",
        text: "视频已经入库；此前没有字幕计划，因此未添加外挂字幕。",
      },
    ]);
    expect(
      (
        tasks.get(first.id)?.metadata.completionContinuation as {
          state: string;
        }
      ).state,
    ).toBe("completed");
    expect(
      (
        tasks.get(second.id)?.metadata.completionContinuation as {
          state: string;
        }
      ).state,
    ).toBe("completed");
    database.close();
  });

  it("does not emit the old download-complete message before Jellyfin import", async () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "autofilm-completion-"),
    );
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const tasks = new TaskStore(database);
    const outbox = new OutboxStore(database);
    const local = tasks.create({
      type: "offline-download",
      title: "Movie",
      state: "completed",
      metadata: {
        completionContinuation: {
          workflowId: "workflow-2",
          state: "pending",
          attempts: 0,
          nextAttemptAt: new Date(0).toISOString(),
        },
        jellyfinRefresh: {
          state: "pending",
          path: "/115/Movies/Movie.mkv",
          attempts: 0,
          nextAttemptAt: new Date(0).toISOString(),
        },
      },
    });
    const agent = {
      async respond() {
        throw new Error("must not run");
      },
    } as unknown as AgentService;
    const worker = new DownloadCompletionWorker(
      tasks,
      agent,
      outbox,
      "https://af.example.test",
    );

    await worker.tick();

    expect(outbox.claimDue()).toHaveLength(0);
    expect(
      (
        tasks.get(local.id)?.metadata.completionContinuation as {
          state: string;
        }
      ).state,
    ).toBe("pending");
    database.close();
  });
});
