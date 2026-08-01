import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../db/database.js";
import { MediaUpgradeStore } from "../../db/media-upgrade-store.js";
import { TaskStore } from "../../db/task-store.js";
import { UserStore } from "../../db/user-store.js";
import type { ToolDependencies } from "../tool-types.js";
import { createMediaUpgradeTools } from "./media-upgrades.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("media upgrade download selection", () => {
  it("keeps Jackett URLs private and submits only resolved magnets", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-upgrade-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const mediaUpgrades = new MediaUpgradeStore(database);
    const tasks = new TaskStore(database);
    const user = new UserStore(database).create({
      username: "upgrade-user",
      displayName: "Upgrade User",
      role: "member",
    });
    const jobId = mediaUpgrades.createJob(user.id);
    const item = mediaUpgrades.createItem({
      jobId,
      jellyfinItemId: "jellyfin-1",
      title: "测试电影",
      query: "Example 2026",
      current: {
        path: "openlist:///115/movie/Example.2026.1080p.mkv",
      },
    });
    const internalUrl =
      "http://jackett.internal.invalid:9117/dl/test?jackett_apikey=private-key";
    mediaUpgrades.update(item.id, {
      state: "awaiting_selection",
      candidates: [
        {
          id: "release-main",
          title: "Example.2026.2160p.REMUX",
          downloadUrl: internalUrl,
          size: 100,
          seeders: 10,
          peers: 2,
          tracker: "Example",
          publishDate: "2026-07-31",
        },
        {
          id: "release-fallback",
          title: "Example.2026.2160p.WEB-DL",
          downloadUrl: "https://jackett.invalid/fallback.torrent",
          size: 80,
          seeders: 8,
          peers: 1,
          tracker: "Example",
          publishDate: "2026-07-31",
        },
      ],
    });
    const submissions: string[] = [];
    const deps = {
      userId: user.id,
      mediaUpgrades,
      tasks,
      jackett: {
        async resolveDownloadUrl(value: string) {
          return value === internalUrl
            ? `magnet:?xt=urn:btih:${"a".repeat(40)}`
            : `magnet:?xt=urn:btih:${"b".repeat(40)}`;
        },
      },
      openList: {
        async mkdir() {},
        instantOfflinePolicy() {
          return { enabled: true, timeoutMs: 40_000 };
        },
        async startOfflineDownload(input: { url: string }) {
          submissions.push(input.url);
          return [{
            id: "remote-1",
            name: "Example",
            state: 1,
            status: "running",
            progress: 0,
            total_bytes: 100,
            error: "",
            provider_task_id: "provider-1",
            provider_submitted_at: new Date().toISOString(),
          }];
        },
      },
    } as unknown as ToolDependencies;
    const tools = createMediaUpgradeTools(deps);
    const getJob = tools.find(
      (tool) => tool.definition.name === "get_media_upgrade_job",
    )!;
    const safeJob = await getJob.execute({ job_id: jobId });
    expect(JSON.stringify(safeJob)).not.toContain("jackett_apikey");
    expect(JSON.stringify(safeJob)).not.toContain("downloadUrl");
    expect(JSON.stringify(safeJob)).toContain("Example.2026.2160p.REMUX");

    const publicJob = safeJob as {
      items: Array<{
        upgrade_item_id: string;
        candidates: Array<{
          title: string;
          upgrade_selection_id: string;
        }>;
      }>;
    };
    const publicItem = publicJob.items[0]!;
    const primarySelection = publicItem.candidates.find(
      (candidate) => candidate.title === "Example.2026.2160p.REMUX",
    )!.upgrade_selection_id;
    const fallbackSelection = publicItem.candidates.find(
      (candidate) => candidate.title === "Example.2026.2160p.WEB-DL",
    )!.upgrade_selection_id;

    const start = tools.find(
      (tool) => tool.definition.name === "start_media_upgrades",
    )!;
    const startParameters = start.definition.parameters as {
      properties: {
        selections: { items: { properties: Record<string, unknown> } };
      };
    };
    const selectionProperties =
      startParameters.properties.selections.items.properties;
    expect(selectionProperties.upgrade_selection_id).toBeDefined();
    expect(selectionProperties.release_candidate_id).toBeUndefined();

    const mismatched = await start.execute({
      selections: [{
        upgrade_item_id: item.id,
        upgrade_selection_id: "release-main",
      }],
    });
    expect(mismatched).toMatchObject({
      submitted: 0,
      failed: 1,
      items: [{
        ok: false,
        error: expect.stringContaining("不属于当前升级项目"),
      }],
    });

    const result = await start.execute({
      selections: [{
        upgrade_item_id: item.id,
        upgrade_selection_id: primarySelection,
        fallback_upgrade_selection_ids: [fallbackSelection],
      }],
    });

    expect(result).toMatchObject({ submitted: 1, failed: 0 });
    expect(result).toMatchObject({
      items: [{
        ok: true,
        result: {
          submissionStatus: "succeeded",
          message: "离线下载提交成功",
        },
      }],
    });
    expect(submissions).toEqual([
      `magnet:?xt=urn:btih:${"a".repeat(40)}`,
    ]);
    const metadata = tasks.list(1)[0]!.metadata;
    expect(metadata.openListTaskId).toBe("remote-1");
    expect(metadata.attemptQueuedAt).toEqual(expect.any(String));
    expect(metadata.attemptStartedAt).toEqual(expect.any(String));
    expect(metadata.providerTaskId).toBe("provider-1");
    expect(metadata.downloadCandidates).toEqual([
      {
        id: "release-main",
        title: "Example.2026.2160p.REMUX",
        magnetUri: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
      },
      {
        id: "release-fallback",
        title: "Example.2026.2160p.WEB-DL",
        magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
      },
    ]);
    expect(JSON.stringify(metadata)).not.toContain("jackett_apikey");
    database.close();
  });
});
