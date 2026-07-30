import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigStore } from "../db/config-store.js";
import { TmdbClient } from "./tmdb.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("TMDB hierarchical metadata", () => {
  it("returns episode rating and falls back to the English overview", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      expect(url.pathname).toBe("/tv/100/season/3/episode/2");
      const english = url.searchParams.get("language") === "en-US";
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            id: 3002,
            name: english ? "Second Episode" : "第二集",
            original_name: "Second Episode",
            season_number: 3,
            episode_number: 2,
            air_date: "2026-07-31",
            overview: english ? "English episode overview." : "",
            vote_average: 8.7,
            vote_count: 42,
          }),
        );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    const configs = {
      service: () => ({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credential: "tmdb-token",
        options: { language: "zh-CN" },
      }),
    } as unknown as ConfigStore;

    const result = await new TmdbClient(configs).metadata({
      mediaType: "tv",
      tmdbId: 100,
      seasonNumber: 3,
      episodeNumber: 2,
    });

    expect(result).toMatchObject({
      scope: "episode",
      title: "第二集",
      seasonNumber: 3,
      episodeNumber: 2,
      overview: "English episode overview.",
      overviewLanguage: "en-US",
      voteAverage: 8.7,
      voteCount: 42,
    });
  });
});
