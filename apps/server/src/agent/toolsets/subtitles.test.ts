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
