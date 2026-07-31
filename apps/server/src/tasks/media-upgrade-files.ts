import path from "node:path";
import type {
  OpenListClient,
  OpenListObject,
} from "../integrations/openlist.js";
import type { JellyfinItem } from "../integrations/jellyfin.js";

export function openListPathFromUri(value: unknown): string {
  const uri = String(value ?? "");
  if (!uri.startsWith("openlist:///")) {
    throw new Error("升级项缺少 OpenList 路径");
  }
  return `/${uri.slice("openlist:///".length)}`;
}

export function toOpenListUri(value: string): string {
  return `openlist:///${value.replace(/^\/+/, "")}`;
}

export function hasVideoStream(item: JellyfinItem): boolean {
  const streams =
    item.MediaStreams ??
    (item.MediaSources?.[0]?.MediaStreams as
      | Array<Record<string, unknown>>
      | undefined) ??
    [];
  return streams.some((stream) => stream.Type === "Video");
}

export function effectiveOriginalOpenListPath(
  current: Record<string, unknown>,
): string {
  const resolved = current.resolvedOriginalPath;
  if (
    typeof resolved === "string" &&
    resolved.startsWith("/") &&
    !resolved.includes("..")
  ) {
    return resolved;
  }
  return openListPathFromUri(current.path);
}

export async function resolveOriginalOpenListPath(
  openList: OpenListClient,
  input: {
    recordedPath: string;
    expectedSize?: number;
  },
): Promise<string> {
  try {
    const exact = await openList.getObject(input.recordedPath, false);
    if (exact.is_dir) throw new Error("Jellyfin 旧媒体路径指向目录而不是视频");
    return exact.path;
  } catch (error) {
    if (!isObjectNotFound(error)) throw error;
  }

  const recordedDirectory = path.posix.dirname(input.recordedPath);
  const directoryParent = path.posix.dirname(recordedDirectory);
  if (
    directoryParent === recordedDirectory ||
    directoryParent === "/" ||
    path.posix.basename(recordedDirectory) === "."
  ) {
    throw new Error("Jellyfin 旧媒体路径不存在，且不满足受限路径纠正规则");
  }

  const directoryMatches = (await openList.listObjects(directoryParent, true))
    .filter(
      (entry) =>
        entry.is_dir &&
        comparableName(entry.name) ===
          comparableName(path.posix.basename(recordedDirectory)),
    );
  if (directoryMatches.length !== 1) {
    throw new Error(
      directoryMatches.length === 0
        ? "Jellyfin 旧媒体目录不存在，未找到唯一的分隔符差异目录"
        : "Jellyfin 旧媒体目录存在多个分隔符等价项，已拒绝猜测",
    );
  }

  const recordedName = path.posix.basename(input.recordedPath);
  const recordedExtension = path.posix.extname(recordedName).toLowerCase();
  const fileMatches = (await openList.listObjects(
    directoryMatches[0]!.path,
    true,
  )).filter(
    (entry) =>
      !entry.is_dir &&
      path.posix.extname(entry.name).toLowerCase() === recordedExtension &&
      comparableName(entry.name) === comparableName(recordedName) &&
      compatibleSize(entry.size, input.expectedSize),
  );
  if (fileMatches.length !== 1) {
    throw new Error(
      fileMatches.length === 0
        ? "已找到等价旧目录，但没有唯一匹配名称和大小的旧视频"
        : "等价旧目录中存在多个同名同大小视频，已拒绝猜测",
    );
  }
  return fileMatches[0]!.path;
}

export async function moveOpenListObjectIdempotently(
  openList: OpenListClient,
  input: {
    sourcePath: string;
    destinationDirectory: string;
    destinationName?: string;
  },
): Promise<OpenListObject> {
  try {
    return await openList.moveObject(input);
  } catch (error) {
    const finalPath = path.posix.join(
      input.destinationDirectory,
      input.destinationName ?? path.posix.basename(input.sourcePath),
    );
    try {
      const existing = await openList.getObject(finalPath, true);
      if (!existing.is_dir) {
        try {
          await openList.getObject(input.sourcePath, true);
        } catch {
          return existing;
        }
      }
    } catch {
      // The destination does not prove that this exact move succeeded.
    }
    throw error;
  }
}

function comparableName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[._\s-]+/g, " ")
    .trim();
}

function compatibleSize(actual: number, expected?: number): boolean {
  return expected === undefined ||
    !Number.isFinite(expected) ||
    expected <= 0 ||
    Math.abs(actual - expected) <= 1024 * 1024;
}

function isObjectNotFound(error: unknown): boolean {
  return error instanceof Error &&
    error.message.toLowerCase().includes("object not found");
}
