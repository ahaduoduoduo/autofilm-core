import { describe, expect, it, vi } from "vitest";
import type { ToolDependencies } from "../tool-types.js";
import { createJellyfinTools } from "./jellyfin.js";

describe("Jellyfin media deletion tool", () => {
  it("continues after one target fails and reports exact deleted items", async () => {
    const deleteItem = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("remote deletion failed"));
    const deps = {
      jellyfin: {
        item: async (id: string) => ({
          Id: id,
          Name: id === "episode-1" ? "第一集" : "第二集",
          Type: "Episode",
          Path: `openlist:///115/tv/show/${id}.mkv`,
          SeriesName: "示例剧",
          ParentIndexNumber: 1,
          IndexNumber: id === "episode-1" ? 1 : 2,
        }),
        deleteItem,
      },
    } as unknown as ToolDependencies;
    const tool = createJellyfinTools(deps).find(
      (candidate) => candidate.definition.name === "delete_jellyfin_items",
    )!;

    const result = (await tool.execute({
      targets: [
        { jellyfin_item_id: "episode-1" },
        { jellyfin_item_id: "episode-2" },
      ],
    })) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: "partial",
      succeeded: 1,
      failed: 1,
    });
    expect(result.results).toEqual([
      expect.objectContaining({
        ok: true,
        itemId: "episode-1",
        path: "openlist:///115/tv/show/episode-1.mkv",
      }),
      expect.objectContaining({
        ok: false,
        itemId: "episode-2",
        error: "remote deletion failed",
      }),
    ]);
    expect(deleteItem).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate IDs before deleting anything", async () => {
    const deleteItem = vi.fn();
    const deps = {
      jellyfin: {
        item: vi.fn(),
        deleteItem,
      },
    } as unknown as ToolDependencies;
    const tool = createJellyfinTools(deps).find(
      (candidate) => candidate.definition.name === "delete_jellyfin_items",
    )!;

    await expect(
      tool.execute({
        targets: [
          { jellyfin_item_id: "movie-1" },
          { jellyfin_item_id: "movie-1" },
        ],
      }),
    ).rejects.toThrow("重复");
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it("does not expose directory-level deletion to the agent", async () => {
    const deleteItem = vi.fn();
    const deps = {
      jellyfin: {
        item: async () => ({
          Id: "series-1",
          Name: "示例剧",
          Type: "Series",
          Path: "openlist:///115/tv/show",
        }),
        deleteItem,
      },
    } as unknown as ToolDependencies;
    const tool = createJellyfinTools(deps).find(
      (candidate) => candidate.definition.name === "delete_jellyfin_items",
    )!;

    const result = (await tool.execute({
      targets: [{ jellyfin_item_id: "series-1" }],
    })) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: "failed",
      succeeded: 0,
      failed: 1,
    });
    expect(deleteItem).not.toHaveBeenCalled();
  });
});
