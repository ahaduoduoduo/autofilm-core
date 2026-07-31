import { describe, expect, it } from "vitest";
import type { TaskSummary } from "@autofilm/contracts";
import { safeDownloadTask } from "./download-candidates.js";

describe("download task candidate redaction", () => {
  it("removes legacy Jackett URLs and magnets from Agent-visible tasks", () => {
    const task = {
      id: "task-1",
      userId: "user-1",
      type: "offline-download",
      title: "Example",
      state: "waiting",
      progress: null,
      statusText: "等待备用资源",
      externalId: null,
      metadata: {
        sourceUrl:
          "http://jackett.internal.invalid:9117/dl/main?jackett_apikey=private-key",
        candidateUrls: [
          "http://jackett.internal.invalid:9117/dl/main?jackett_apikey=private-key",
          `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=Fallback`,
        ],
        attempts: [{
          url: "http://jackett.internal.invalid:9117/dl/main?jackett_apikey=private-key",
          reason: "timeout",
        }],
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      completedAt: null,
    } satisfies TaskSummary;

    const safe = safeDownloadTask(task);
    expect(JSON.stringify(safe)).not.toContain("jackett.internal.invalid");
    expect(JSON.stringify(safe)).not.toContain("jackett_apikey");
    expect(JSON.stringify(safe)).not.toContain("magnet:");
    expect(safe.metadata.downloadCandidates).toEqual([
      {
        id: expect.any(String),
        title: "历史备用资源 1",
      },
      {
        id: expect.any(String),
        title: "历史备用资源 2",
      },
    ]);
  });

  it("uses stored Jackett titles without exposing resolved magnets", () => {
    const task = {
      id: "task-2",
      userId: "user-1",
      type: "offline-download",
      title: "Example",
      state: "running",
      progress: 0,
      statusText: "running",
      externalId: "remote-1",
      metadata: {
        downloadCandidates: [{
          id: "release-1",
          title: "Jackett.Release.Title",
          magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
        }],
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      completedAt: null,
    } satisfies TaskSummary;

    expect(safeDownloadTask(task).metadata.downloadCandidates).toEqual([
      { id: "release-1", title: "Jackett.Release.Title" },
    ]);
  });
});
