import { describe, expect, it } from "vitest";
import type { OpenListClient, OpenListObject } from "../integrations/openlist.js";
import { resolveOriginalOpenListPath } from "./media-upgrade-files.js";

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
