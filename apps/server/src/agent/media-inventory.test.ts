import { describe, expect, it } from "vitest";
import type { JellyfinItem } from "../integrations/jellyfin.js";
import {
  classifyResolution,
  duplicateMovieGroups,
  movieVersions,
} from "./media-inventory.js";

describe("Jellyfin movie inventory", () => {
  it("classifies cropped cinema rasters by their nominal source class", () => {
    expect(classifyResolution(1280, 536)).toBe("720p");
    expect(classifyResolution(1920, 800)).toBe("1080p");
    expect(classifyResolution(2560, 1080)).toBe("1080p");
    expect(classifyResolution(3440, 1440)).toBe("1440p");
    expect(classifyResolution(3840, 1600)).toBe("2160p");
    expect(classifyResolution(undefined, undefined)).toBe("unknown");
  });

  it("flattens every Jellyfin media source into a stable version", () => {
    const item = {
      Id: "display-item",
      Name: "示例电影",
      Type: "Movie",
      ProductionYear: 2026,
      ProviderIds: { Tmdb: "123" },
      MediaSources: [
        {
          Id: "version-4k",
          Path: "openlist:///115/movie/example-4k.mkv",
          Container: "mkv",
          Size: 100,
          MediaStreams: [
            {
              Type: "Video",
              Width: 3840,
              Height: 1600,
              Codec: "hevc",
              VideoRangeType: "DOVIWithHDR10",
            },
          ],
        },
        {
          Id: "version-1080p",
          Path: "/movie/example-1080p.mkv",
          MediaStreams: [
            {
              Type: "Video",
              Width: 1920,
              Height: 800,
              Codec: "h264",
            },
          ],
        },
      ],
    } as JellyfinItem;

    expect(movieVersions(item)).toEqual([
      expect.objectContaining({
        jellyfinItemId: "version-4k",
        displayItemId: "display-item",
        resolution: "2160p",
        source: "openlist",
      }),
      expect.objectContaining({
        jellyfinItemId: "version-1080p",
        resolution: "1080p",
        source: "local",
      }),
    ]);
  });

  it("does not count a BoxSet as a movie version", () => {
    expect(
      movieVersions({
        Id: "collection-1",
        Name: "示例合集",
        Type: "BoxSet",
      }),
    ).toEqual([]);
  });

  it("separates provider-confirmed and title-only duplicate groups", () => {
    const versions = [
      version("a", "同一电影", 2020, { Tmdb: "10" }, 3840, 1600),
      version("b", "同一电影", 2020, { Tmdb: "10" }, 1920, 800),
      version("c", "候选电影", 2021, {}, 1920, 1080),
      version("d", "候选电影", 2021, {}, 1280, 720),
    ];

    const groups = duplicateMovieGroups(versions);

    expect(groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: "confirmed",
          reason: "TMDB ID 相同",
        }),
        expect.objectContaining({
          confidence: "candidate",
          reason: expect.stringContaining("标题和年份"),
        }),
      ]),
    );
    expect(
      groups.find((group) => group.confidence === "confirmed")?.versions[0]
        ?.resolution,
    ).toBe("2160p");
  });
});

function version(
  id: string,
  name: string,
  productionYear: number,
  providerIds: Record<string, string>,
  width: number,
  height: number,
) {
  return movieVersions({
    Id: id,
    Name: name,
    Type: "Movie",
    ProductionYear: productionYear,
    ProviderIds: providerIds,
    Path: `/movie/${id}.mkv`,
    MediaStreams: [{ Type: "Video", Width: width, Height: height }],
  })[0]!;
}
