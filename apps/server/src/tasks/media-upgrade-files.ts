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

export function currentMediaSize(
  current: Record<string, unknown>,
): number | undefined {
  const sources = current.mediaSources;
  if (!Array.isArray(sources)) return undefined;
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    const size = Number((source as Record<string, unknown>).Size);
    if (Number.isFinite(size) && size > 0) return size;
  }
  return undefined;
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
    expectedSize?: number;
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
        } catch (sourceError) {
          if (
            isObjectNotFound(sourceError) &&
            compatibleSize(existing.size, input.expectedSize)
          ) {
            return existing;
          }
        }
      }
    } catch {
      // The destination does not prove that this exact move succeeded.
    }

    // A failed two-step operation may leave either the destination name in the
    // source directory (legacy rename-first behavior) or the source name in
    // the destination directory (move-first behavior). Continue only when the
    // original source is absent and the intermediate size still matches.
    if (isObjectNotFound(error) && input.destinationName) {
      const sourceMissing = await openList
        .getObject(input.sourcePath, true)
        .then(() => false)
        .catch((sourceError) => {
          if (isObjectNotFound(sourceError)) return true;
          throw sourceError;
        });
      if (sourceMissing) {
        const recoveryCandidates = [
          {
            path: path.posix.join(
              path.posix.dirname(input.sourcePath),
              input.destinationName,
            ),
            destinationDirectory: input.destinationDirectory,
            destinationName: undefined,
          },
          {
            path: path.posix.join(
              input.destinationDirectory,
              path.posix.basename(input.sourcePath),
            ),
            destinationDirectory: input.destinationDirectory,
            destinationName: input.destinationName,
          },
        ].filter(
          (candidate, index, all) =>
            candidate.path !== input.sourcePath &&
            candidate.path !== finalPath &&
            all.findIndex((value) => value.path === candidate.path) === index,
        );
        for (const candidate of recoveryCandidates) {
          const intermediate = await openList
            .getObject(candidate.path, true)
            .catch((candidateError) => {
              if (isObjectNotFound(candidateError)) return undefined;
              throw candidateError;
            });
          if (
            intermediate &&
            !intermediate.is_dir &&
            compatibleSize(intermediate.size, input.expectedSize)
          ) {
            return openList.moveObject({
              sourcePath: intermediate.path,
              destinationDirectory: candidate.destinationDirectory,
              destinationName: candidate.destinationName,
            });
          }
        }
      }
    }
    throw error;
  }
}

export function isLikelySameMediaRelease(input: {
  currentPath: string;
  currentSize?: number;
  candidateName: string;
  candidateSize?: number;
}): boolean {
  const currentSize = input.currentSize;
  const candidateSize = input.candidateSize;
  if (
    !currentSize ||
    !candidateSize ||
    !Number.isFinite(currentSize) ||
    !Number.isFinite(candidateSize) ||
    currentSize <= 0 ||
    candidateSize <= 0
  ) {
    return false;
  }
  const tolerance = Math.max(16 * 1024 * 1024, currentSize * 0.002);
  if (Math.abs(candidateSize - currentSize) > tolerance) return false;
  return releaseFingerprint(input.currentPath) ===
    releaseFingerprint(input.candidateName);
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

function releaseFingerprint(value: string): string {
  const baseName = path.posix.basename(value).replace(
    /\.(?:mkv|mp4|m4v|avi|mov|ts|m2ts|wmv|webm)$/iu,
    "",
  );
  return baseName
    .replace(/\.upgrade-[a-f0-9]{8}$/iu, "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
