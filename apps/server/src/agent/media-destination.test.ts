import { describe, expect, it } from "vitest";
import {
  resolveMediaDestination,
  type DownloadMediaType,
} from "./media-destination.js";

function dependencies(title = "The Example Show") {
  return {
    roots: {
      mediaLibraryRoots() {
        return {
          movie: "/115/nvideo/movie",
          tv: "/115/nvideo/tv",
        };
      },
    },
    catalog: {
      async details(tmdbId: number, mediaType: DownloadMediaType) {
        return {
          id: tmdbId,
          mediaType,
          title: "示例",
          originalTitle: title,
          englishTitle: title,
          overview: "",
          releaseDate: "2026-01-01",
          posterPath: "",
        };
      },
    },
  };
}

describe("media download destination", () => {
  it("places one TV season in the normalized season directory", async () => {
    const { roots, catalog } = dependencies("The Example Show");
    await expect(
      resolveMediaDestination(roots, catalog, {
        mediaType: "tv",
        tmdbId: 123,
        seasons: [3],
      }),
    ).resolves.toEqual({
      destination: "/115/nvideo/tv/The.Example.Show/S03",
      refreshPath: "/115/nvideo/tv/The.Example.Show",
      providerIds: { Tmdb: "123" },
      mediaTitle: "示例",
      mediaType: "tv",
      tmdbId: 123,
      seasons: [3],
    });
  });

  it("places a multi-season pack in the series root", async () => {
    const { roots, catalog } = dependencies("The Example Show");
    const result = await resolveMediaDestination(roots, catalog, {
      mediaType: "tv",
      tmdbId: 123,
      seasons: [1, 2, 3],
    });
    expect(result.destination).toBe(
      "/115/nvideo/tv/The.Example.Show",
    );
    expect(result.refreshPath).toBe(result.destination);
  });

  it("places movies in the current month below the configured root", async () => {
    const { roots, catalog } = dependencies("Example Movie");
    const result = await resolveMediaDestination(
      roots,
      catalog,
      {
        mediaType: "movie",
        tmdbId: 456,
        seasons: [],
      },
      new Date("2026-07-29T12:00:00Z"),
    );
    expect(result.destination).toBe("/115/nvideo/movie/2026-07");
    expect(result.providerIds).toEqual({ Tmdb: "456" });
  });

  it("rejects a TV download without a season and a movie with seasons", async () => {
    const { roots, catalog } = dependencies();
    await expect(
      resolveMediaDestination(roots, catalog, {
        mediaType: "tv",
        tmdbId: 123,
        seasons: [],
      }),
    ).rejects.toThrow("至少一个季号");
    await expect(
      resolveMediaDestination(roots, catalog, {
        mediaType: "movie",
        tmdbId: 456,
        seasons: [1],
      }),
    ).rejects.toThrow("电影下载不能包含季号");
  });

  it("uses a deterministic fallback for an unusable title", async () => {
    const { roots, catalog } = dependencies("剧：？");
    const result = await resolveMediaDestination(roots, catalog, {
      mediaType: "tv",
      tmdbId: 789,
      seasons: [1, 2],
    });
    expect(result.destination).toBe("/115/nvideo/tv/tmdb-789");
  });
});
