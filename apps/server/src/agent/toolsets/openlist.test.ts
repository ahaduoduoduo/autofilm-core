import { describe, expect, it } from "vitest";
import type { ToolDependencies } from "../tool-types.js";
import { createOpenListTools } from "./openlist.js";

describe("OpenList download tools", () => {
  it("computes a multi-season destination instead of accepting one from AI", async () => {
    const createdDirectories: string[] = [];
    const submissions: Array<{ path: string; url: string }> = [];
    const createdTasks: Array<Record<string, unknown>> = [];
    const deps = {
      userId: "user-1",
      openList: {
        mediaLibraryRoots() {
          return {
            movie: "/115/nvideo/movie",
            tv: "/115/nvideo/tv",
          };
        },
        instantOfflinePolicy() {
          return { enabled: true, timeoutMs: 20_000 };
        },
        async mkdir(path: string) {
          createdDirectories.push(path);
        },
        async startOfflineDownload(input: { path: string; url: string }) {
          submissions.push(input);
          return [{
            id: "remote-1",
            name: "Example.S01-S03",
            state: 1,
            status: "running",
            progress: 0,
            total_bytes: 100,
            error: "",
          }];
        },
      },
      tmdb: {
        async details(tmdbId: number, mediaType: "movie" | "tv") {
          return {
            id: tmdbId,
            mediaType,
            title: "示例剧",
            originalTitle: "Example Show",
            englishTitle: "Example Show",
            overview: "",
            releaseDate: "2026-01-01",
            posterPath: "",
          };
        },
      },
      tasks: {
        create(input: Record<string, unknown>) {
          createdTasks.push(input);
          return { id: "local-1", ...input };
        },
      },
    } as unknown as ToolDependencies;
    const tool = createOpenListTools(deps).find(
      (item) => item.definition.name === "start_offline_download",
    )!;

    const result = await tool.execute({
      url: "magnet:?xt=urn:btih:example",
      fallback_urls: [],
      media_type: "tv",
      tmdb_id: 123,
      seasons: [1, 2, 3],
      title: "Example S01-S03",
    });

    expect(createdDirectories).toEqual(["/115/nvideo/tv/Example.Show"]);
    expect(submissions).toEqual([{
      path: "/115/nvideo/tv/Example.Show",
      url: "magnet:?xt=urn:btih:example",
    }]);
    expect(createdTasks[0]?.metadata).toMatchObject({
      destination: "/115/nvideo/tv/Example.Show",
      jellyfinRefreshPath: "/115/nvideo/tv/Example.Show",
      jellyfinProviderIds: { Tmdb: "123" },
      media: {
        type: "tv",
        tmdbId: 123,
        seasons: [1, 2, 3],
        isMultiSeason: true,
      },
    });
    expect(result).toBeTruthy();
  });

  it("does not expose a model-controlled destination parameter", () => {
    const placeholder = {} as never;
    const tools = createOpenListTools({
      userId: "user-1",
      openList: placeholder,
      tmdb: placeholder,
      tasks: placeholder,
    } as unknown as ToolDependencies);
    for (const name of ["start_offline_download", "start_batch_download"]) {
      const definition = tools.find((tool) => tool.definition.name === name)!
        .definition;
      const parameters = definition.parameters as {
        properties: Record<string, unknown>;
      };
      expect(parameters.properties.destination).toBeUndefined();
      expect(parameters.properties.media_type).toBeDefined();
      expect(parameters.properties.tmdb_id).toBeDefined();
      expect(parameters.properties.seasons).toBeDefined();
    }
  });
});
