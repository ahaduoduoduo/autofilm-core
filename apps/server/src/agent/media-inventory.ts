import type {
  JellyfinClient,
  JellyfinItem,
} from "../integrations/jellyfin.js";

export type ResolutionClass =
  | "sd"
  | "720p"
  | "1080p"
  | "1440p"
  | "2160p"
  | "4320p"
  | "unknown";

export interface MovieVersion {
  jellyfinItemId: string;
  displayItemId: string;
  mediaSourceId: string;
  name: string;
  originalTitle?: string;
  productionYear?: number;
  path?: string;
  source: "openlist" | "local" | "unknown";
  providerIds: Record<string, string>;
  width?: number;
  height?: number;
  resolution: ResolutionClass;
  codec?: string;
  container?: string;
  videoRange?: string;
  bitrate?: number;
  size?: number;
  audio: Array<{
    language?: string;
    codec?: string;
    profile?: string;
    channels?: number;
    title?: string;
  }>;
}

export interface DuplicateMovieGroup {
  groupId: string;
  confidence: "confirmed" | "candidate";
  reason: string;
  name: string;
  productionYear?: number;
  providerIds: Record<string, string>;
  versions: MovieVersion[];
}

type JsonRecord = Record<string, unknown>;

export class JellyfinMovieInventory {
  constructor(private readonly jellyfin: JellyfinClient) {}

  async versions(): Promise<MovieVersion[]> {
    return (await this.jellyfin.allMovies())
      .filter((item) => item.Type === "Movie")
      .flatMap(movieVersions);
  }

  async duplicates(): Promise<DuplicateMovieGroup[]> {
    return duplicateMovieGroups(await this.versions());
  }
}

export function classifyResolution(
  width: number | undefined,
  height: number | undefined,
): ResolutionClass {
  if (!width || !height || width <= 0 || height <= 0) return "unknown";
  if (width >= 7_000 || height >= 4_000) return "4320p";
  if (width >= 3_800 || height >= 2_000) return "2160p";
  if (width >= 3_000 || height >= 1_200) return "1440p";
  if (width >= 1_600 || height >= 900) return "1080p";
  if (width >= 1_100 || height >= 650) return "720p";
  return "sd";
}

export function movieVersions(item: JellyfinItem): MovieVersion[] {
  if (item.Type !== "Movie") return [];
  const sources =
    item.MediaSources && item.MediaSources.length > 0
      ? item.MediaSources
      : [{
          Id: item.Id,
          Path: item.Path,
          MediaStreams: item.MediaStreams ?? [],
        }];
  return sources.map((source, index) => {
    const streams = recordArray(source.MediaStreams);
    const fallbackStreams = item.MediaStreams ?? [];
    const mediaStreams = streams.length > 0 ? streams : fallbackStreams;
    const video = mediaStreams.find((stream) => stream.Type === "Video");
    const width = optionalNumber(video?.Width);
    const height = optionalNumber(video?.Height);
    const sourceId = optionalString(source.Id) ?? item.Id;
    const path = optionalString(source.Path) ?? item.Path;
    return {
      jellyfinItemId: sourceId,
      displayItemId: item.Id,
      mediaSourceId: sourceId || `${item.Id}:${index}`,
      name: item.Name,
      originalTitle: item.OriginalTitle,
      productionYear: item.ProductionYear,
      path,
      source: path?.startsWith("openlist:///")
        ? "openlist"
        : path
          ? "local"
          : "unknown",
      providerIds: item.ProviderIds ?? {},
      width,
      height,
      resolution: classifyResolution(width, height),
      codec: optionalString(video?.Codec),
      container: optionalString(source.Container),
      videoRange:
        optionalString(video?.VideoRangeType) ??
        optionalString(video?.VideoRange),
      bitrate:
        optionalNumber(video?.BitRate) ?? optionalNumber(source.Bitrate),
      size: optionalNumber(source.Size),
      audio: mediaStreams
        .filter((stream) => stream.Type === "Audio")
        .map((stream) => ({
          language: optionalString(stream.Language),
          codec: optionalString(stream.Codec),
          profile: optionalString(stream.Profile),
          channels: optionalNumber(stream.Channels),
          title: optionalString(stream.Title),
        })),
    };
  });
}

export function duplicateMovieGroups(
  versions: MovieVersion[],
): DuplicateMovieGroup[] {
  const confirmed = confirmedGroups(versions);
  const confirmedMembers = new Set(
    confirmed.flatMap((group) =>
      group.versions.map((version) => versionKey(version)),
    ),
  );
  const candidates = groupBy(
    versions.filter(
      (version) => !confirmedMembers.has(versionKey(version)),
    ),
    (version) =>
      `${normalizeTitle(version.name)}:${version.productionYear ?? "unknown"}`,
  )
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) =>
      createGroup(
        `candidate:${key}`,
        "candidate",
        "标题和年份相同，但缺少一致的 TMDB/IMDb ID",
        members,
      ),
    );
  return [...confirmed, ...candidates].sort(
    (left, right) =>
      right.versions.length - left.versions.length ||
      left.name.localeCompare(right.name, "zh-CN"),
  );
}

function confirmedGroups(versions: MovieVersion[]): DuplicateMovieGroup[] {
  const byIdentity = new Map<string, MovieVersion[]>();
  for (const version of versions) {
    const tmdb = providerId(version.providerIds, "Tmdb");
    const imdb = providerId(version.providerIds, "Imdb");
    const identity = tmdb
      ? `tmdb:${tmdb}`
      : imdb
        ? `imdb:${imdb}`
        : version.displayItemId !== version.jellyfinItemId
          ? `item:${version.displayItemId}`
          : undefined;
    if (!identity) continue;
    const group = byIdentity.get(identity) ?? [];
    group.push(version);
    byIdentity.set(identity, group);
  }
  return [...byIdentity.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([identity, members]) =>
      createGroup(
        `confirmed:${identity}`,
        "confirmed",
        identity.startsWith("tmdb:")
          ? "TMDB ID 相同"
          : identity.startsWith("imdb:")
            ? "IMDb ID 相同"
            : "Jellyfin 已识别为同一电影的多个媒体版本",
        members,
      ),
    );
}

function createGroup(
  groupId: string,
  confidence: "confirmed" | "candidate",
  reason: string,
  versions: MovieVersion[],
): DuplicateMovieGroup {
  const sorted = [...versions].sort(compareQualityFacts);
  const first = sorted[0]!;
  return {
    groupId,
    confidence,
    reason,
    name: first.name,
    productionYear: first.productionYear,
    providerIds: first.providerIds,
    versions: sorted,
  };
}

function compareQualityFacts(left: MovieVersion, right: MovieVersion): number {
  const pixels =
    (right.width ?? 0) * (right.height ?? 0) -
    (left.width ?? 0) * (left.height ?? 0);
  if (pixels !== 0) return pixels;
  return (right.bitrate ?? 0) - (left.bitrate ?? 0);
}

function providerId(
  providerIds: Record<string, string>,
  name: string,
): string | undefined {
  const entry = Object.entries(providerIds).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1]?.trim() || undefined;
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function groupBy<T>(
  values: T[],
  keyOf: (value: T) => string,
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return [...groups.entries()];
}

function versionKey(version: MovieVersion): string {
  return `${version.displayItemId}:${version.mediaSourceId}`;
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is JsonRecord =>
          Boolean(entry) && typeof entry === "object",
      )
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
