import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigStore } from "../db/config-store.js";
import { JellyfinClient } from "./jellyfin.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("Jellyfin subtitle uploads", () => {
  it("sends every subtitle format through the binary streaming endpoint", async () => {
    const expected = Buffer.from([0x50, 0x47, 0x00, 0xff]);
    let received = Buffer.alloc(0);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      expect(request.method).toBe("POST");
      expect(url.pathname).toBe("/AutoFilm/Videos/episode-1/Subtitles");
      expect(url.searchParams.get("format")).toBe("sup");
      expect(url.searchParams.get("language")).toBe("zh");
      expect(url.searchParams.get("isForced")).toBe("true");
      expect(url.searchParams.get("isHearingImpaired")).toBe("false");
      expect(request.headers["content-type"]).toBe("application/octet-stream");
      expect(request.headers["content-length"]).toBe(String(expected.length));
      expect(request.headers.authorization).toContain('Token="test-token"');
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = Buffer.concat(chunks);
        response.writeHead(204).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    const configs = {
      service: () => ({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credential: "test-token",
        options: {},
      }),
    } as unknown as ConfigStore;

    await new JellyfinClient(configs).uploadSubtitle({
      itemId: "episode-1",
      format: ".SUP",
      language: "zh",
      stream: Readable.from([expected]),
      contentLength: expected.length,
      isForced: true,
    });

    expect(received).toEqual(expected);
  });
});

describe("Jellyfin media deletion", () => {
  it("deletes the exact item through Jellyfin with service authentication", async () => {
    const server = createServer((request, response) => {
      expect(request.method).toBe("DELETE");
      expect(request.url).toBe("/Items/movie-version-1");
      expect(request.headers.authorization).toContain('Token="test-token"');
      response.writeHead(204).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    const configs = {
      service: () => ({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credential: "test-token",
        options: {},
      }),
    } as unknown as ConfigStore;

    await new JellyfinClient(configs).deleteItem("movie-version-1");
  });
});

describe("Jellyfin BoxSet members", () => {
  it("reads collection children with media fields", async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      expect(url.pathname).toBe("/Items");
      expect(url.searchParams.get("ParentId")).toBe("boxset-1");
      expect(url.searchParams.get("IncludeItemTypes")).toBe("Movie");
      expect(url.searchParams.get("CollapseBoxSetItems")).toBe("false");
      expect(url.searchParams.get("Fields")).toContain("MediaStreams");
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({
          Items: [{ Id: "movie-1", Name: "Movie", Type: "Movie" }],
          TotalRecordCount: 1,
        }));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    const configs = {
      service: () => ({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credential: "test-token",
        options: {},
      }),
    } as unknown as ConfigStore;

    await expect(
      new JellyfinClient(configs).allBoxSetItems("boxset-1"),
    ).resolves.toEqual([
      { Id: "movie-1", Name: "Movie", Type: "Movie" },
    ]);
  });
});
