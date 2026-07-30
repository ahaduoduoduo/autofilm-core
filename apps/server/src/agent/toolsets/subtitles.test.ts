import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubtitleWorkspaceStore } from "../../subtitles/workspace-store.js";
import type { ToolDependencies } from "../tool-types.js";
import { createSubtitleTools } from "./subtitles.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("subtitle placement plans", () => {
  it("keeps immutable UUID mappings and retries only failed items", async () => {
    const { dependencies, store, workspace, fileIds, uploadSubtitle } =
      fixture();
    const tools = createSubtitleTools(dependencies);
    const prepare = tools.find(
      (candidate) =>
        candidate.definition.name === "prepare_subtitle_placements",
    )!;
    const place = tools.find(
      (candidate) => candidate.definition.name === "place_subtitles",
    )!;
    const preview = (await prepare.execute({
      workspace_id: workspace.id,
      mappings: [
        {
          workspace_file_id: fileIds[0],
          jellyfin_item_id: "episode-1",
        },
        {
          workspace_file_id: fileIds[1],
          jellyfin_item_id: "episode-2",
        },
      ],
    })) as {
      placementPlanId: string;
      mappings: Array<Record<string, unknown>>;
    };

    expect(preview.mappings.map((mapping) => mapping.workspaceFileId)).toEqual(
      fileIds,
    );
    expect(preview.mappings[0]).toMatchObject({
      fileName: "Show.S01E01.chs.ass",
      relativePath: "S01/Show.S01E01.chs.ass",
      format: "ass",
      language: "chs",
      jellyfinItemId: "episode-1",
    });
    expect(
      Object.keys(preview.mappings[0]!).some((key) =>
        key.toLowerCase().includes("index"),
      ),
    ).toBe(false);
    const first = (await place.execute({
      workspace_id: workspace.id,
      placement_plan_id: preview.placementPlanId,
    })) as Record<string, unknown>;
    expect(first.status).toBe("partial");
    expect(first.succeeded).toBe(1);
    expect(first.failed).toBe(1);
    expect(store.get("user-1", workspace.id)).toBeDefined();

    const second = (await place.execute({
      workspace_id: workspace.id,
      placement_plan_id: preview.placementPlanId,
    })) as Record<string, unknown>;
    expect(second.status).toBe("success");
    expect(uploadSubtitle).toHaveBeenCalledTimes(3);
    expect(store.get("user-1", workspace.id)).toBeUndefined();
  });

  it("rejects implicit file reuse and exact duplicate mappings", async () => {
    const { dependencies, workspace, fileIds } = fixture();
    const prepare = createSubtitleTools(dependencies).find(
      (candidate) =>
        candidate.definition.name === "prepare_subtitle_placements",
    )!;

    await expect(
      prepare.execute({
        workspace_id: workspace.id,
        mappings: [
          {
            workspace_file_id: fileIds[0],
            jellyfin_item_id: "episode-1",
          },
          {
            workspace_file_id: fileIds[0],
            jellyfin_item_id: "episode-2",
          },
        ],
      }),
    ).rejects.toThrow("allow_file_reuse=true");
    await expect(
      prepare.execute({
        workspace_id: workspace.id,
        mappings: [
          {
            workspace_file_id: fileIds[0],
            jellyfin_item_id: "episode-1",
            allow_file_reuse: true,
          },
          {
            workspace_file_id: fileIds[0],
            jellyfin_item_id: "episode-1",
            allow_file_reuse: true,
          },
        ],
      }),
    ).rejects.toThrow("完全重复");
  });

  it("cleans and uploads at most eight subtitles concurrently", async () => {
    const { dependencies, workspace, fileIds, metrics, clean, uploadSubtitle } =
      concurrencyFixture(10);
    const tools = createSubtitleTools(dependencies);
    const prepare = tools.find(
      (candidate) =>
        candidate.definition.name === "prepare_subtitle_placements",
    )!;
    const place = tools.find(
      (candidate) => candidate.definition.name === "place_subtitles",
    )!;
    const preview = (await prepare.execute({
      workspace_id: workspace.id,
      mappings: fileIds.map((fileId, index) => ({
        workspace_file_id: fileId,
        jellyfin_item_id: `episode-${index + 1}`,
      })),
    })) as { placementPlanId: string };

    const result = (await place.execute({
      workspace_id: workspace.id,
      placement_plan_id: preview.placementPlanId,
    })) as Record<string, unknown>;

    expect(result.status).toBe("success");
    expect(clean).toHaveBeenCalledTimes(10);
    expect(uploadSubtitle).toHaveBeenCalledTimes(10);
    expect(metrics.maxCleanActive).toBe(8);
    expect(metrics.maxUploadActive).toBe(8);
  });
});

function fixture(): {
  dependencies: ToolDependencies;
  store: SubtitleWorkspaceStore;
  workspace: ReturnType<SubtitleWorkspaceStore["create"]>;
  fileIds: string[];
  uploadSubtitle: ReturnType<typeof vi.fn>;
} {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "autofilm-tools-"));
  directories.push(dataDir);
  const store = new SubtitleWorkspaceStore(dataDir);
  const workspace = store.create("user-1");
  store.appendArchive({
    userId: "user-1",
    workspaceId: workspace.id,
    subtitleId: "sub-one",
    filename: "season.zip",
    files: [
      {
        filename: "Show.S01E01.chs.ass",
        relativePath: "S01/Show.S01E01.chs.ass",
        format: "ass",
        sizeBytes: 3,
        data: Buffer.from("one"),
      },
      {
        filename: "Show.S01E02.chs.srt",
        relativePath: "S01/Show.S01E02.chs.srt",
        format: "srt",
        sizeBytes: 3,
        data: Buffer.from("two"),
      },
    ],
  });
  const fileIds = store
    .require("user-1", workspace.id)
    .files.map((file) => file.id);
  const uploadSubtitle = vi
    .fn()
    .mockRejectedValueOnce(new Error("first failed"))
    .mockResolvedValue(undefined);
  const dependencies = {
    userId: "user-1",
    subtitleWorkspaces: store,
    subtitleCleaner: {
      clean: async (_filename: string, data: Buffer) => ({
        data,
        removed: 0,
        summary: "clean",
      }),
    },
    jellyfin: {
      item: async (id: string) => ({
        Id: id,
        Name: id,
        Type: "Episode",
        Path: `openlist:///show/${id}.mkv`,
        MediaStreams: [],
      }),
      uploadSubtitle,
    },
  } as unknown as ToolDependencies;
  return {
    dependencies,
    store,
    workspace,
    fileIds,
    uploadSubtitle,
  };
}

function concurrencyFixture(count: number): {
  dependencies: ToolDependencies;
  workspace: ReturnType<SubtitleWorkspaceStore["create"]>;
  fileIds: string[];
  metrics: { maxCleanActive: number; maxUploadActive: number };
  clean: ReturnType<typeof vi.fn>;
  uploadSubtitle: ReturnType<typeof vi.fn>;
} {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "autofilm-tools-"));
  directories.push(dataDir);
  const store = new SubtitleWorkspaceStore(dataDir);
  const workspace = store.create("user-1");
  store.appendArchive({
    userId: "user-1",
    workspaceId: workspace.id,
    subtitleId: "season-pack",
    filename: "season.zip",
    files: Array.from({ length: count }, (_, index) => {
      const episode = String(index + 1).padStart(2, "0");
      const filename = `Show.S01E${episode}.chs.ass`;
      const data = Buffer.from(`subtitle-${episode}`);
      return {
        filename,
        relativePath: `S01/${filename}`,
        format: "ass",
        sizeBytes: data.byteLength,
        data,
      };
    }),
  });
  const fileIds = store
    .require("user-1", workspace.id)
    .files.map((file) => file.id);
  const metrics = { maxCleanActive: 0, maxUploadActive: 0 };
  const cleanGate = deferred();
  const uploadGate = deferred();
  let cleanActive = 0;
  let uploadActive = 0;
  const clean = vi.fn(async (_filename: string, data: Buffer) => {
    cleanActive += 1;
    metrics.maxCleanActive = Math.max(metrics.maxCleanActive, cleanActive);
    if (cleanActive === 8) cleanGate.resolve();
    await cleanGate.promise;
    cleanActive -= 1;
    return { data, removed: 0, summary: "clean" };
  });
  const uploadSubtitle = vi.fn(async () => {
    uploadActive += 1;
    metrics.maxUploadActive = Math.max(metrics.maxUploadActive, uploadActive);
    if (uploadActive === 8) uploadGate.resolve();
    await uploadGate.promise;
    uploadActive -= 1;
  });
  const dependencies = {
    userId: "user-1",
    subtitleWorkspaces: store,
    subtitleCleaner: { clean },
    jellyfin: {
      item: async (id: string) => ({
        Id: id,
        Name: id,
        Type: "Episode",
        Path: `openlist:///show/${id}.mkv`,
        MediaStreams: [],
      }),
      uploadSubtitle,
    },
  } as unknown as ToolDependencies;
  return {
    dependencies,
    workspace,
    fileIds,
    metrics,
    clean,
    uploadSubtitle,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
