import type {
  MediaUpgradeCandidate,
  MediaUpgradeItem,
  MediaUpgradeStore,
} from "../../db/media-upgrade-store.js";
import { classifyResolution } from "../media-inventory.js";
import {
  currentMediaSize,
  isLikelySameMediaRelease,
  openListPathFromUri,
} from "../../tasks/media-upgrade-files.js";

type JsonRecord = Record<string, unknown>;

export function mediaUpgradeJobResult(
  store: MediaUpgradeStore,
  jobId: string,
) {
  const items = store.items(jobId);
  return {
    job_id: jobId,
    total: items.length,
    states: Object.fromEntries(
      [...new Set(items.map((item) => item.state))].map((state) => [
        state,
        items.filter((item) => item.state === state).length,
      ]),
    ),
    items: items.map(publicUpgradeItem),
  };
}

export function requireUpgradeCandidate(
  item: MediaUpgradeItem,
  selectionId: string,
): MediaUpgradeCandidate {
  const prefix = selectionPrefix(item.id);
  if (!selectionId.startsWith(prefix)) {
    throw new Error(
      `${item.title} 的 upgrade_selection_id 不属于当前升级项目；请使用 search_media_upgrade_candidates 或 get_media_upgrade_job 返回的选择 ID`,
    );
  }
  const id = selectionId.slice(prefix.length);
  const candidate = item.candidates.find((value) => value.id === id);
  if (!candidate) {
    throw new Error(`${item.title} 的升级候选已经变化，请重新读取该升级任务`);
  }
  return candidate;
}

function publicUpgradeItem(item: MediaUpgradeItem) {
  return {
    upgrade_item_id: item.id,
    job_id: item.jobId,
    jellyfin_item_id: item.jellyfinItemId,
    title: item.title,
    query: item.query,
    state: item.state,
    current: summarizeCurrent(item.current),
    candidates: item.candidates.slice(0, 20).map(
      ({ id, downloadUrl: _downloadUrl, ...candidate }) => ({
        upgrade_selection_id: upgradeSelectionId(item.id, id),
        ...candidate,
        sameAsCurrent: isLikelySameMediaRelease({
          currentPath: openListPathFromUri(item.current.path),
          currentSize: currentMediaSize(item.current),
          candidateName: candidate.title,
          candidateSize: candidate.size,
        }),
      }),
    ),
    candidateCount: item.candidates.length,
    selected_upgrade_selection_id: item.selectedCandidateId
      ? upgradeSelectionId(item.id, item.selectedCandidateId)
      : undefined,
    download_task_id: item.downloadTaskId,
    new_path: item.newPath,
    backup_path: item.backupPath,
    error: item.error,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

function upgradeSelectionId(itemId: string, candidateId: string): string {
  return `${selectionPrefix(itemId)}${candidateId}`;
}

function selectionPrefix(itemId: string): string {
  return `upgrade:v1:${itemId}:`;
}

function summarizeCurrent(current: JsonRecord) {
  const fallbackStreams = recordArray(current.mediaStreams);
  const sources = recordArray(current.mediaSources);
  const effectiveSources = sources.length > 0
    ? sources
    : fallbackStreams.length > 0
      ? [{ MediaStreams: fallbackStreams }]
      : [];
  return {
    path: optionalString(current.path),
    type: optionalString(current.type),
    originalTitle: optionalString(current.originalTitle),
    productionYear: optionalNumber(current.productionYear),
    providerIds: recordValue(current.providerIds),
    season: optionalNumber(current.season),
    episode: optionalNumber(current.episode),
    mediaSources: effectiveSources.slice(0, 8).map((source) =>
      summarizeSource(source, fallbackStreams)
    ),
  };
}

function summarizeSource(source: JsonRecord, fallbackStreams: JsonRecord[]) {
  const sourceStreams = recordArray(source.MediaStreams);
  const streams = sourceStreams.length > 0 ? sourceStreams : fallbackStreams;
  const video = streams.find((stream) => stream.Type === "Video");
  const subtitles = streams.filter((stream) => stream.Type === "Subtitle");
  const width = optionalNumber(video?.Width);
  const height = optionalNumber(video?.Height);
  return {
    id: optionalString(source.Id),
    name: optionalString(source.Name),
    path: optionalString(source.Path),
    container: optionalString(source.Container),
    size: optionalNumber(source.Size),
    bitrate: optionalNumber(source.Bitrate),
    video: video
      ? {
          codec: optionalString(video.Codec),
          profile: optionalString(video.Profile),
          width,
          height,
          resolution: classifyResolution(width, height),
          bitrate: optionalNumber(video.BitRate),
          bitDepth: optionalNumber(video.BitDepth),
          videoRange:
            optionalString(video.VideoRangeType) ??
            optionalString(video.VideoRange),
          frameRate:
            optionalNumber(video.RealFrameRate) ??
            optionalNumber(video.AverageFrameRate),
        }
      : undefined,
    audio: streams
      .filter((stream) => stream.Type === "Audio")
      .slice(0, 8)
      .map((stream) => ({
        language: optionalString(stream.Language),
        codec: optionalString(stream.Codec),
        profile: optionalString(stream.Profile),
        channels: optionalNumber(stream.Channels),
        title: optionalString(stream.Title),
      })),
    subtitles: {
      count: subtitles.length,
      external: subtitles.filter((stream) => stream.IsExternal === true).length,
      languages: [...new Set(
        subtitles
          .map((stream) => optionalString(stream.Language))
          .filter((language): language is string => Boolean(language)),
      )],
    },
  };
}

function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is JsonRecord =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
