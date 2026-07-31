import { describe, expect, it } from "vitest";
import { MediaUpgradeStore } from "../db/media-upgrade-store.js";
import { openDatabase } from "../db/database.js";
import { OutboxStore } from "../db/outbox-store.js";
import { TaskStore } from "../db/task-store.js";
import { UserStore } from "../db/user-store.js";
import type { JellyfinClient, JellyfinItem } from "../integrations/jellyfin.js";
import type { OpenListClient } from "../integrations/openlist.js";
import { MediaUpgradeWorker } from "./media-upgrade-worker.js";

describe("MediaUpgradeWorker", () => {
  it("activates completed items independently and keeps failed peers isolated", async () => {
    const db = openDatabase(":memory:");
    const user = new UserStore(db).create({
      username: "owner",
      displayName: "Owner",
      role: "owner",
    });
    const tasks = new TaskStore(db);
    const upgrades = new MediaUpgradeStore(db);
    const outbox = new OutboxStore(db);
    const jobId = upgrades.createJob(user.id);
    const successful = upgrades.createItem({
      jobId,
      jellyfinItemId: "movie-success",
      title: "升级成功",
      query: "Movie 2026",
      current: {
        path: "openlist:///115/movies/old.mkv",
        type: "Movie",
      },
    });
    const failed = upgrades.createItem({
      jobId,
      jellyfinItemId: "movie-failed",
      title: "升级失败",
      query: "Other 2026",
      current: {
        path: "openlist:///115/movies/other-old.mkv",
        type: "Movie",
      },
    });
    const notificationTarget = {
      channel: "native",
      providerInstanceId: "wechat-main",
      targetId: "wx-user",
    };
    const successfulDownload = tasks.create({
      userId: user.id,
      type: "offline-download",
      title: "成功下载",
      state: "completed",
      metadata: {
        destination: `/115/autofilm-staging/upgrades/${successful.id}`,
        remoteResultPath: `/115/autofilm-staging/upgrades/${successful.id}`,
        notificationTarget,
      },
    });
    const failedDownload = tasks.create({
      userId: user.id,
      type: "offline-download",
      title: "失败下载",
      state: "failed",
      metadata: { notificationTarget },
    });
    upgrades.update(successful.id, {
      state: "downloading",
      downloadTaskId: successfulDownload.id,
    });
    upgrades.update(failed.id, {
      state: "downloading",
      downloadTaskId: failedDownload.id,
    });

    let activated = false;
    const moves: Array<{
      sourcePath: string;
      destinationDirectory: string;
      destinationName?: string;
    }> = [];
    const deleted: string[] = [];
    const openList = {
      async moveObject(input: {
        sourcePath: string;
        destinationDirectory: string;
        destinationName?: string;
      }) {
        moves.push(input);
        return {
          path: `${input.destinationDirectory}/${input.destinationName ?? input.sourcePath.split("/").at(-1)}`,
          name: input.destinationName ?? "old.mkv",
          size: 1,
          is_dir: false,
          modified: "",
          created: "",
        };
      },
      async getObject() {
        throw new Error("not found");
      },
      async mkdir() {},
      async deleteObject(path: string) {
        deleted.push(path);
      },
    } as unknown as OpenListClient;
    const jellyfin = {
      async inspectReplacement() {
        return {
          requestedPath: "staging",
          candidates: [
            {
              path: `/115/autofilm-staging/upgrades/${successful.id}/new.mkv`,
              name: "new",
              size: 20,
            },
          ],
        };
      },
      async item(id: string): Promise<JellyfinItem> {
        return {
          Id: id,
          Name: "Movie",
          Type: "Movie",
          Path: activated
            ? `openlist:///115/movies/new.upgrade-${successful.id.slice(0, 8)}.mkv`
            : "openlist:///115/movies/old.mkv",
          MediaStreams: activated ? [{ Type: "Video" }] : [],
        };
      },
      async previewReplacement() {
        return {
          previewToken: "preview",
          current: {
            path: "openlist:///115/movies/old.mkv",
            width: 1280,
            height: 720,
            streams: [],
          },
          replacement: {
            path: "openlist:///115/movies/new.mkv",
            width: 3840,
            height: 2160,
            streams: [{ Type: "Video" }],
          },
        };
      },
      async applyReplacement() {
        activated = true;
        return { rollbackToken: "rollback" };
      },
      async rollbackReplacement() {},
    } as unknown as JellyfinClient;

    const worker = new MediaUpgradeWorker(
      upgrades,
      tasks,
      openList,
      jellyfin,
      outbox,
    );
    await worker.tick();

    expect(upgrades.get(successful.id)).toMatchObject({
      state: "succeeded",
      newPath:
        `/115/movies/new.upgrade-${successful.id.slice(0, 8)}.mkv`,
      backupPath:
        `/115/autofilm-backups/upgrades/${successful.id}/old.mkv`,
    });
    expect(upgrades.get(failed.id)).toMatchObject({
      state: "failed",
    });
    expect(moves).toHaveLength(2);
    expect(deleted).toEqual([
      `/115/autofilm-staging/upgrades/${successful.id}`,
    ]);
    expect(outbox.claimDue()).toHaveLength(2);
    db.close();
  });

  it("rejects a downloaded file with fewer pixels than the current video", async () => {
    const db = openDatabase(":memory:");
    const user = new UserStore(db).create({
      username: "owner",
      displayName: "Owner",
      role: "owner",
    });
    const tasks = new TaskStore(db);
    const upgrades = new MediaUpgradeStore(db);
    const item = upgrades.createItem({
      jobId: upgrades.createJob(user.id),
      jellyfinItemId: "movie",
      title: "Movie",
      query: "Movie",
      current: {
        path: "openlist:///115/movies/old.mkv",
        type: "Movie",
      },
    });
    const download = tasks.create({
      userId: user.id,
      type: "offline-download",
      title: "download",
      state: "completed",
      metadata: {
        destination: `/115/autofilm-staging/upgrades/${item.id}`,
        remoteResultPath: `/115/autofilm-staging/upgrades/${item.id}`,
      },
    });
    upgrades.update(item.id, {
      state: "downloading",
      downloadTaskId: download.id,
    });
    const openList = {
      async moveObject(input: {
        destinationDirectory: string;
        destinationName?: string;
      }) {
        return {
          path: `${input.destinationDirectory}/${input.destinationName}`,
          is_dir: false,
        };
      },
    } as unknown as OpenListClient;
    const jellyfin = {
      async inspectReplacement() {
        return {
          requestedPath: "",
          candidates: [{ path: "/115/staging/new.mkv", name: "new", size: 1 }],
        };
      },
      async item(id: string) {
        return {
          Id: id,
          Name: "Movie",
          Type: "Movie",
          Path: "openlist:///115/movies/old.mkv",
        };
      },
      async previewReplacement() {
        return {
          previewToken: "preview",
          current: {
            path: "old",
            width: 3840,
            height: 2160,
            streams: [],
          },
          replacement: {
            path: "new",
            width: 1920,
            height: 1080,
            streams: [],
          },
        };
      },
      async applyReplacement() {
        throw new Error("must not apply");
      },
    } as unknown as JellyfinClient;
    const worker = new MediaUpgradeWorker(
      upgrades,
      tasks,
      openList,
      jellyfin,
      new OutboxStore(db),
    );

    await worker.tick();

    expect(upgrades.get(item.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("低于原文件"),
    });
    db.close();
  });
});
