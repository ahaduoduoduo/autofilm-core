import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeMagnetUri,
  torrentToMagnet,
} from "./torrent-magnet.js";

describe("torrent magnet conversion", () => {
  it("hashes the original info dictionary and keeps tracker metadata", () => {
    const info = Buffer.from(
      "d6:lengthi42e4:name5:Movie12:piece lengthi16384e6:pieces20:bbbbbbbbbbbbbbbbbbbbe",
    );
    const tracker = "https://tracker.example/announce";
    const torrent = Buffer.concat([
      Buffer.from(`d8:announce${Buffer.byteLength(tracker)}:${tracker}4:info`),
      info,
      Buffer.from("e"),
    ]);
    const magnet = torrentToMagnet(torrent, "Jackett Movie Title");
    expect(magnet).toContain(
      `xt=urn:btih:${createHash("sha1").update(info).digest("hex")}`,
    );
    expect(magnet).toContain(
      `dn=${encodeURIComponent("Jackett Movie Title")}`,
    );
    expect(magnet).toContain(`tr=${encodeURIComponent(tracker)}`);
  });

  it("rejects pure BitTorrent v2 metadata", () => {
    const torrent = Buffer.from(
      "d4:infod12:meta versioni2e4:name5:Movie9:file treedeee",
    );
    expect(() => torrentToMagnet(torrent, "Movie")).toThrow(
      "BitTorrent v2",
    );
  });

  it("requires a v1 infohash and replaces dn with the trusted title", () => {
    const hash = "c".repeat(40);
    const magnet = normalizeMagnetUri(
      `magnet:?xt=urn:btih:${hash}&dn=Untrusted`,
      "Jackett Title",
    );
    expect(magnet).toBe(
      `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent("Jackett Title")}`,
    );
    expect(() =>
      normalizeMagnetUri("magnet:?xt=urn:btmh:1220deadbeef", "Movie"),
    ).toThrow("v1 infohash");
  });
});
