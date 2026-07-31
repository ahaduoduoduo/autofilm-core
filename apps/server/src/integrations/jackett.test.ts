import { createHash } from "node:crypto";
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
              index === 24
                ? `magnet:?xt=urn:btih:${"a".repeat(40)}`
                : "",
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
      candidateId: expect.any(String),
    });
    expect(second.hasMore).toBe(false);
    expect(second.results).toHaveLength(5);
    expect(second.results[0]).toMatchObject({
      index: 20,
      title: "Release 5",
      size: 5 * 1024,
      candidateId: expect.any(String),
    });
    expect(JSON.stringify(first)).not.toContain("example.invalid");
  });

  it("downloads a Jackett torrent locally and resolves it to a v1 magnet", async () => {
    const info = Buffer.from(
      "d6:lengthi123e4:name4:Test12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaae",
    );
    const tracker = "udp://tracker.example:80";
    const torrent = Buffer.concat([
      Buffer.from(`d8:announce${Buffer.byteLength(tracker)}:${tracker}4:info`),
      info,
      Buffer.from("e"),
    ]);
    let torrentRequests = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/dl/test") {
        torrentRequests += 1;
        expect(url.searchParams.get("jackett_apikey")).toBe("secret");
        response.setHeader("content-type", "application/x-bittorrent");
        response.end(torrent);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        Results: [{
          Title: "Jackett Release Title",
          Link:
            "http://jackett.internal.invalid:9117/dl/test?jackett_apikey=secret",
          Size: 123,
        }],
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const configs = {
      service: () => ({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credential: "secret",
        options: {},
      }),
    } as unknown as ConfigStore;
    const client = new JackettClient(configs);
    const page = await client.search("Example");
    expect(JSON.stringify(page)).not.toContain("jackett_apikey");

    const resolved = await client.resolveCandidate(
      page.results[0]!.candidateId,
    );
    const expectedHash = createHash("sha1").update(info).digest("hex");
    expect(resolved.title).toBe("Jackett Release Title");
    expect(resolved.magnetUri).toContain(`xt=urn:btih:${expectedHash}`);
    expect(resolved.magnetUri).toContain(
      `dn=${encodeURIComponent("Jackett Release Title")}`,
    );
    expect(resolved.magnetUri).toContain(
      `tr=${encodeURIComponent(tracker)}`,
    );
    expect(torrentRequests).toBe(1);

    await client.resolveCandidate(page.results[0]!.candidateId);
    expect(torrentRequests).toBe(1);
  });
});
