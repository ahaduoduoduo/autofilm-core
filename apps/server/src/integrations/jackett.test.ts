import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigStore } from "../db/config-store.js";
import { JackettClient } from "./jackett.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("Jackett release search", () => {
  it("sorts every result by size before paging and reuses the query cache", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      expect(url.searchParams.get("Query")).toBe("Example 2026");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          Results: Array.from({ length: 25 }, (_, index) => ({
            Title: `Release ${index + 1}`,
            Link: `https://example.invalid/${index + 1}.torrent`,
            MagnetUri:
              index === 24 ? "magnet:?xt=urn:btih:largest" : "",
            Size: (index + 1) * 1024,
            Seeders: index,
            Tracker: "Example",
          })),
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const configs = {
      service: () => ({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credential: "test-key",
        options: {},
      }),
    } as unknown as ConfigStore;
    const client = new JackettClient(configs);

    const first = await client.search("Example 2026", 0);
    const second = await client.search("Example 2026", 1);

    expect(requests).toBe(1);
    expect(first.total).toBe(25);
    expect(first.totalPages).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(first.results).toHaveLength(20);
    expect(first.results[0]).toMatchObject({
      index: 0,
      title: "Release 25",
      size: 25 * 1024,
      downloadUrl: "magnet:?xt=urn:btih:largest",
    });
    expect(second.hasMore).toBe(false);
    expect(second.results).toHaveLength(5);
    expect(second.results[0]).toMatchObject({
      index: 20,
      title: "Release 5",
      size: 5 * 1024,
      downloadUrl: "https://example.invalid/5.torrent",
    });
  });
});
