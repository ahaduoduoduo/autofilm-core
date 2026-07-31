import { describe, expect, it } from "vitest";
import type { OpenListClient, OpenListObject } from "../integrations/openlist.js";
import {
  isLikelySameMediaRelease,
  moveOpenListObjectIdempotently,
  resolveOriginalOpenListPath,
} from "./media-upgrade-files.js";

const recordedPath =
  "/cloud/library/A2/Example Film 1988 Extended Cut 720p BluRay x264-GRP/" +
  "Example Film 1988 Extended Cut 720p BluRay DD5.1 x264-GRP.mkv";
const actualDirectory =
  "/cloud/library/A2/Example.Film.1988.Extended.Cut.720p.BluRay.x264-GRP";
const actualPath =
  `${actualDirectory}/` +
  "Example.Film.1988.Extended.Cut.720p.BluRay.DD5.1.x264-GRP.mkv";

describe("media upgrade original path resolution", () => {
  it("returns an exact existing file without listing directories", async () => {
    const lists: string[] = [];
    const openList = {
      async getObject(path: string) {
        return object(path, false, 100);
      },
      async listObjects(path: string) {
        lists.push(path);
        return [];
      },
    } as unknown as OpenListClient;

    await expect(resolveOriginalOpenListPath(openList, {
      recordedPath,
      expectedSize: 100,
    })).resolves.toBe(recordedPath);
    expect(lists).toEqual([]);
  });

  it("accepts one punctuation-only directory and file correction", async () => {
    const lists: string[] = [];
    const openList = {
      async getObject() {
        throw new Error("object not found");
      },
      async listObjects(path: string) {
        lists.push(path);
        if (path === "/cloud/library/A2") {
          return [object(actualDirectory, true, 0)];
        }
        if (path === actualDirectory) {
          return [object(actualPath, false, 8_529_735_788)];
        }
        return [];
      },
    } as unknown as OpenListClient;

    await expect(resolveOriginalOpenListPath(openList, {
      recordedPath,
      expectedSize: 8_529_735_680,
    })).resolves.toBe(actualPath);
    expect(lists).toEqual(["/cloud/library/A2", actualDirectory]);
  });

  it("rejects ambiguous normalized directories", async () => {
    const openList = {
      async getObject() {
        throw new Error("object not found");
      },
      async listObjects() {
        return [
          object(actualDirectory, true, 0),
          object(actualDirectory.replaceAll(".", "_"), true, 0),
        ];
      },
    } as unknown as OpenListClient;

    await expect(resolveOriginalOpenListPath(openList, {
      recordedPath,
      expectedSize: 8_529_735_680,
    })).rejects.toThrow("存在多个分隔符等价项");
  });
});

describe("media upgrade move recovery", () => {
  it("continues a legacy rename-before-move intermediate file", async () => {
    const source = "/115/staging/item/new.mkv";
    const intermediate = "/115/staging/item/new.upgrade-12345678.mkv";
    const destination = "/115/movies/title";
    const moved = `${destination}/new.upgrade-12345678.mkv`;
    const calls: string[] = [];
    const openList = {
      async moveObject(input: { sourcePath: string }) {
        calls.push(input.sourcePath);
        if (input.sourcePath === source) {
          throw new Error("failed to get src object: object not found");
        }
        return object(moved, false, 100);
      },
      async getObject(path: string) {
        if (path === intermediate) return object(intermediate, false, 100);
        throw new Error("object not found");
      },
    } as unknown as OpenListClient;

    await expect(
      moveOpenListObjectIdempotently(openList, {
        sourcePath: source,
        destinationDirectory: destination,
        destinationName: "new.upgrade-12345678.mkv",
        expectedSize: 100,
      }),
    ).resolves.toMatchObject({ path: moved });
    expect(calls).toEqual([source, intermediate]);
  });

  it("finishes a move-before-rename intermediate file", async () => {
    const source = "/115/staging/item/new.mkv";
    const destination = "/115/movies/title";
    const intermediate = `${destination}/new.mkv`;
    const finalPath = `${destination}/new.upgrade-12345678.mkv`;
    const calls: Array<{ sourcePath: string; destinationName?: string }> = [];
    const openList = {
      async moveObject(input: {
        sourcePath: string;
        destinationName?: string;
      }) {
        calls.push({
          sourcePath: input.sourcePath,
          destinationName: input.destinationName,
        });
        if (input.sourcePath === source) {
          throw new Error(
            "wait for moved object: object not found; object remains at " +
              intermediate,
          );
        }
        return object(finalPath, false, 200);
      },
      async getObject(path: string) {
        if (path === intermediate) return object(intermediate, false, 200);
        throw new Error("object not found");
      },
    } as unknown as OpenListClient;

    await expect(
      moveOpenListObjectIdempotently(openList, {
        sourcePath: source,
        destinationDirectory: destination,
        destinationName: "new.upgrade-12345678.mkv",
        expectedSize: 200,
      }),
    ).resolves.toMatchObject({ path: finalPath });
    expect(calls).toEqual([
      {
        sourcePath: source,
        destinationName: "new.upgrade-12345678.mkv",
      },
      {
        sourcePath: intermediate,
        destinationName: "new.upgrade-12345678.mkv",
      },
    ]);
  });
});

describe("same media release protection", () => {
  it("recognizes the same release with small sidecar size differences", () => {
    expect(
      isLikelySameMediaRelease({
        currentPath:
          "/115/movie/U-571.2000.Bluray.1080p.DTS-HD.x264-Grym.MKV",
        currentSize: 14_262_702_901,
        candidateName: "U-571.2000.Bluray.1080p.DTS-HD.x264-Grym",
        candidateSize: 14_262_796_450,
      }),
    ).toBe(true);
  });

  it("does not reject a different release with the same approximate size", () => {
    expect(
      isLikelySameMediaRelease({
        currentPath: "/115/movie/Movie.2000.1080p-GRP-A.mkv",
        currentSize: 10_000_000_000,
        candidateName: "Movie.2000.1080p-GRP-B",
        candidateSize: 10_000_000_000,
      }),
    ).toBe(false);
  });
});

function object(
  path: string,
  isDirectory: boolean,
  size: number,
): OpenListObject {
  return {
    path,
    name: path.split("/").at(-1) ?? "",
    size,
    is_dir: isDirectory,
    modified: "",
    created: "",
  };
}
