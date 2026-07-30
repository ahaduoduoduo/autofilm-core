import path from "node:path";
import type { CatalogDetails } from "../integrations/tmdb.js";

export type DownloadMediaType = "movie" | "tv";

export interface MediaSelection {
  mediaType: DownloadMediaType;
  tmdbId: number;
  seasons: number[];
}

export interface MediaDestination {
  destination: string;
  refreshPath: string;
  providerIds?: Record<string, string>;
  mediaTitle: string;
  mediaType: DownloadMediaType;
  tmdbId: number;
  seasons: number[];
}

interface MediaRootSource {
  mediaLibraryRoots(): { movie: string; tv: string };
}

interface CatalogDetailsSource {
  details(
    tmdbId: number,
    mediaType: DownloadMediaType,
  ): Promise<CatalogDetails>;
}

export async function resolveMediaDestination(
  roots: MediaRootSource,
  catalog: CatalogDetailsSource,
  selection: MediaSelection,
  now = new Date(),
): Promise<MediaDestination> {
  validateSelection(selection);
  const details = await catalog.details(
    selection.tmdbId,
    selection.mediaType,
  );
  if (
    details.id !== selection.tmdbId ||
    details.mediaType !== selection.mediaType
  ) {
    throw new Error("TMDB 返回的媒体身份与下载参数不一致");
  }

  const mediaTitle =
    details.englishTitle || details.originalTitle || details.title;
  const directoryName = sanitizeDirectoryName(mediaTitle, selection.tmdbId);
  const configuredRoots = roots.mediaLibraryRoots();

  if (selection.mediaType === "movie") {
    const month =
      `${now.getFullYear()}-` +
      String(now.getMonth() + 1).padStart(2, "0");
    const destination = path.posix.join(configuredRoots.movie, month);
    return {
      destination,
      refreshPath: destination,
      mediaTitle: details.title || mediaTitle,
      mediaType: selection.mediaType,
      tmdbId: selection.tmdbId,
      seasons: [],
    };
  }

  const seriesRoot = path.posix.join(configuredRoots.tv, directoryName);
  const destination =
    selection.seasons.length === 1
      ? path.posix.join(
          seriesRoot,
          `S${String(selection.seasons[0]).padStart(2, "0")}`,
        )
      : seriesRoot;
  return {
    destination,
    refreshPath: seriesRoot,
    providerIds: { Tmdb: String(selection.tmdbId) },
    mediaTitle: details.title || mediaTitle,
    mediaType: selection.mediaType,
    tmdbId: selection.tmdbId,
    seasons: selection.seasons,
  };
}

function validateSelection(selection: MediaSelection): void {
  if (!Number.isInteger(selection.tmdbId) || selection.tmdbId <= 0) {
    throw new Error("tmdb_id 必须是正整数");
  }
  if (selection.mediaType === "movie") {
    if (selection.seasons.length > 0) {
      throw new Error("电影下载不能包含季号");
    }
    return;
  }
  if (selection.seasons.length === 0) {
    throw new Error("电视剧下载必须提供至少一个季号");
  }
  if (
    selection.seasons.some(
      (season) => !Number.isInteger(season) || season < 0 || season > 999,
    )
  ) {
    throw new Error("电视剧季号必须是 0 到 999 之间的整数");
  }
  if (new Set(selection.seasons).size !== selection.seasons.length) {
    throw new Error("电视剧季号不能重复");
  }
}

function sanitizeDirectoryName(title: string, tmdbId: number): string {
  const sanitized = title
    .trim()
    .replace(/\s+/g, ".")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_")
    .replace(/\.+$/g, "")
    .replace(/^[-.]+|[-.]+$/g, "");
  return /[a-zA-Z0-9]/.test(sanitized) ? sanitized : `tmdb-${tmdbId}`;
}
