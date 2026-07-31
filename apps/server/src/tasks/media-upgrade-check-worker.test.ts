import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.js";
import { MediaUpgradeCheckStore } from "../db/media-upgrade-check-store.js";
import { UserStore } from "../db/user-store.js";
import {
  hasResolution,
  MediaUpgradeCheckWorker,
} from "./media-upgrade-check-worker.js";

describe("bulk media upgrade check worker", () => {
  it("searches eight targets concurrently and exposes only matches", async () => {
    const db = openDatabase(":memory:");
    const user = new UserStore(db).create({
      username: "upgrade-check",
      displayName: "Upgrade Check",
      role: "member",
    });
    const checks = new MediaUpgradeCheckStore(db);
    let active = 0;
    let maximumActive = 0;
    const jackett = {
      searchAll: async (query: string) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        const number = Number(query.match(/Film (\d+)/)?.[1] ?? 0);
        return [
          {
            candidateId: `candidate-${number}`,
            title:
              number % 2 === 0
                ? `Film.${number}.1080p.WEB-DL`
                : `Film.${number}.2160p.UHD.BluRay`,
            downloadUrl: `magnet:?xt=urn:btih:${number}`,
            size: number * 1_000,
            seeders: number,
            peers: 0,
            tracker: "test",
            publishDate: "2026-07-31",
          },
        ];
      },
    };
    const agentEvents: string[] = [];
    const agent = {
      respond: async (input: { text: string }) => {
        agentEvents.push(input.text);
        return "批量检查完成";
      },
    };
    const notifications: unknown[] = [];
    const outbox = {
      enqueueMessages: (input: unknown) => notifications.push(input),
    };
    const job = checks.create({
      userId: user.id,
      targetResolution: "2160p",
      notificationTarget: {
        channel: "wechat",
        providerInstanceId: "wechat-main",
        targetId: "chat-1",
      },
      targets: Array.from({ length: 9 }, (_, index) => ({
        jellyfinItemId: `item-${index + 1}`,
        title: `电影 ${index + 1}`,
        originalTitle: `Film ${index + 1}`,
        productionYear: 2000 + index,
        currentResolution: "1080p",
      })),
    });
    const worker = new MediaUpgradeCheckWorker(
      checks,
      jackett as never,
      agent as never,
      outbox as never,
      "https://af.example.test",
    );

    await worker.tick();
    expect(checks.summary(job.id, user.id)).toMatchObject({
      state: "running",
      checked: 8,
      pending: 1,
    });
    await worker.tick();

    expect(maximumActive).toBe(8);
    expect(checks.summary(job.id, user.id)).toMatchObject({
      state: "completed",
      total: 9,
      matched: 5,
      noMatch: 4,
      failed: 0,
    });
    const results = checks.matchedResults({
      jobId: job.id,
      userId: user.id,
      page: 0,
      limit: 20,
    });
    expect(results?.items).toHaveLength(5);
    expect(
      results?.items.every((item) =>
        item.candidates.every((candidate) =>
          candidate.title.includes("2160p"),
        ),
      ),
    ).toBe(true);
    expect(agentEvents[0]).toContain("命中 5");
    expect(agentEvents[0]).not.toContain("电影 2");
    expect(notifications).toHaveLength(1);
    db.close();
  });

  it("recognizes common 4K, 8K, and 1080 markers", () => {
    expect(hasResolution("Movie.2160p.UHD.BluRay", "2160p")).toBe(true);
    expect(hasResolution("Movie 4K WEB-DL", "2160p")).toBe(true);
    expect(hasResolution("Movie.1080p.WEB-DL", "2160p")).toBe(false);
    expect(hasResolution("Movie_4320p_HEVC", "4320p")).toBe(true);
    expect(hasResolution("Movie-1080i-BluRay", "1080p")).toBe(true);
  });
});
