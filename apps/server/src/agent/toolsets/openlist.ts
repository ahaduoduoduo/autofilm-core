import { randomUUID } from "node:crypto";
import {
  resolveMediaDestination,
  type DownloadMediaType,
  type MediaDestination,
  type MediaSelection,
} from "../media-destination.js";
import type { AgentTool, ToolDependencies } from "../tool-types.js";
import { normalizeMagnetUri } from "../../integrations/torrent-magnet.js";
import {
  directMagnetCandidate,
  taskDownloadCandidates,
  uniqueDownloadCandidates,
  type DownloadCandidate,
} from "../../tasks/download-candidates.js";
import {
  delay,
  objectSchema,
  optionalStringArray,
  requireArray,
  requireNumber,
  requireString,
  stringProperty,
} from "./schema.js";

export function createOpenListTools(deps: ToolDependencies): AgentTool[] {
  return [
    {
      definition: {
        name: "start_offline_download",
        description:
          "在 OpenList 中创建一个离线下载。仅在用户明确选定资源后调用。",
        parameters: objectSchema(
          {
            release_candidate_id: stringProperty(
              "search_releases 返回的主资源 candidateId",
            ),
            magnet_uri: stringProperty(
              "仅用于用户直接提供的磁力链接；与 release_candidate_id 二选一",
            ),
            fallback_candidate_ids: {
              type: "array",
              maxItems: 8,
              items: { type: "string" },
              description:
                "search_releases 返回的备用 candidateId，按优先级排列",
            },
            fallback_magnet_uris: {
              type: "array",
              maxItems: 8,
              items: { type: "string" },
              description: "用户直接提供的备用磁力链接，按优先级排列",
            },
            media_type: {
              type: "string",
              enum: ["movie", "tv"],
              description: "媒体类型",
            },
            tmdb_id: {
              type: "integer",
              minimum: 1,
              description: "search_catalog 返回的真实 TMDB ID",
            },
            seasons: {
              type: "array",
              maxItems: 100,
              items: { type: "integer", minimum: 0, maximum: 999 },
              description:
                "电视剧包含的全部季号；单季传一个，多季合集传多个，电影传空数组",
            },
            title: stringProperty("任务显示名称"),
          },
          [
            "fallback_candidate_ids",
            "fallback_magnet_uris",
            "media_type",
            "tmdb_id",
            "seasons",
            "title",
          ],
        ),
      },
      execute: async (args) => {
        const target = await resolveTarget(deps, args);
        const title = requireString(args, "title");
        const resolution = await resolveDownloadCandidates(deps, args, title);
        return startDownload(deps, {
          ...resolution,
          title,
          target,
          workflowId: randomUUID(),
        });
      },
    },
    {
      definition: {
        name: "start_batch_download",
        description:
          "向同一个 OpenList 目录串行提交多个离线下载。用于分集资源；为降低网盘风控风险，任务之间保留间隔。",
        parameters: objectSchema(
          {
            media_type: {
              type: "string",
              enum: ["movie", "tv"],
              description: "媒体类型",
            },
            tmdb_id: {
              type: "integer",
              minimum: 1,
              description: "search_catalog 返回的真实 TMDB ID",
            },
            seasons: {
              type: "array",
              maxItems: 100,
              items: { type: "integer", minimum: 0, maximum: 999 },
              description:
                "所有分集所属的季号；单季传一个，多季资源传多个，电影传空数组",
            },
            downloads: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                properties: {
                  release_candidate_id: stringProperty(
                    "search_releases 返回的主资源 candidateId",
                  ),
                  magnet_uri: stringProperty(
                    "用户直接提供的磁力链接；与 release_candidate_id 二选一",
                  ),
                  fallback_candidate_ids: {
                    type: "array",
                    maxItems: 8,
                    items: { type: "string" },
                    description: "这一项的备用 candidateId，按优先级排列",
                  },
                  fallback_magnet_uris: {
                    type: "array",
                    maxItems: 8,
                    items: { type: "string" },
                    description: "这一项由用户直接提供的备用磁力链接",
                  },
                  title: stringProperty("任务名称"),
                },
                required: [
                  "fallback_candidate_ids",
                  "fallback_magnet_uris",
                  "title",
                ],
                additionalProperties: false,
              },
            },
          },
          ["media_type", "tmdb_id", "seasons", "downloads"],
        ),
      },
      execute: async (args) => {
        const target = await resolveTarget(deps, args);
        const downloads = requireArray(args, "downloads");
        if (downloads.length > 50) throw new Error("批量下载最多提交 50 项");
        const workflowId = randomUUID();
        const results: unknown[] = [];
        for (const [index, value] of downloads.entries()) {
          if (typeof value !== "object" || !value) {
            throw new Error(`downloads[${index}] 格式无效`);
          }
          const item = value as Record<string, unknown>;
          const title = requireString(item, "title");
          const resolution = await resolveDownloadCandidates(
            deps,
            item,
            title,
          );
          results.push(
            await startDownload(deps, {
              ...resolution,
              title,
              target,
              workflowId,
            }),
          );
          if (index < downloads.length - 1) await delay(1_500);
        }
        return {
          destination: target.destination,
          media: mediaSummary(target),
          submitted: results.length,
          tasks: results,
        };
      },
    },
    {
      definition: {
        name: "resume_offline_download",
        description:
          "用户明确选择备用资源后，使用任务保存的 candidateId 恢复离线任务。",
        parameters: objectSchema(
          {
            task_id: stringProperty("list_download_tasks 返回的 waiting 任务 ID"),
            candidate_id: stringProperty(
              "list_download_tasks 返回的备用资源 candidateId",
            ),
          },
          ["task_id", "candidate_id"],
        ),
      },
      execute: async (args) =>
        resumeDownload(
          deps,
          requireString(args, "task_id"),
          requireString(args, "candidate_id"),
        ),
    },
  ];
}

async function startDownload(
  deps: ToolDependencies,
  input: {
    candidates: DownloadCandidate[];
    unavailableFallbacks: Array<{
      reference: string;
      error: string;
    }>;
    title: string;
    target: MediaDestination;
    workflowId: string;
  },
): Promise<unknown> {
  const candidates = uniqueDownloadCandidates(input.candidates);
  const primary = candidates[0];
  if (!primary) throw new Error("没有可提交的磁力资源");
  const policy = deps.openList.instantOfflinePolicy();
  const metadata = downloadMetadata(deps, input, candidates, policy);
  await deps.openList.mkdir(input.target.destination);
  const remoteTasks = await deps.openList.startOfflineDownload({
    path: input.target.destination,
    url: primary.magnetUri,
  });
  if (remoteTasks.length === 0) {
    return deps.tasks.create({
      userId: deps.userId,
      type: "offline-download",
      title: input.title,
      state: "waiting",
      metadata,
    });
  }
  return remoteTasks.map((remoteTask) =>
    deps.tasks.create({
      userId: deps.userId,
      type: "offline-download",
      title: input.title,
      state: "running",
      externalId: remoteTask.id,
      metadata: {
        ...metadata,
        remoteName: remoteTask.name,
      },
    }),
  );
}

async function resumeDownload(
  deps: ToolDependencies,
  taskId: string,
  candidateId: string,
): Promise<unknown> {
  const task = deps.tasks.get(taskId);
  if (!task || task.userId !== deps.userId) {
    throw new Error("等待中的下载任务不存在");
  }
  if (
    task.state !== "waiting" ||
    task.metadata.awaitingFallbackSelection !== true
  ) {
    throw new Error("该任务当前不在等待备用资源选择");
  }
  const candidates = taskDownloadCandidates(task);
  const selectedIndex = candidates.findIndex(
    (candidate) => candidate.id === candidateId,
  );
  const currentIndex = Number(task.metadata.attemptIndex ?? 0);
  if (selectedIndex <= currentIndex) {
    throw new Error("所选 candidateId 不是该任务尚未尝试的备用资源");
  }
  const selected = candidates[selectedIndex]!;
  const magnetUri = selected.magnetUri ||
    (selected.legacySourceUrl
      ? await deps.jackett.resolveDownloadUrl(
          selected.legacySourceUrl,
          legacyCandidateTitle(deps, task, selected.legacySourceUrl) ??
            selected.title,
        )
      : "");
  if (!magnetUri) throw new Error("备用资源无法转换为磁力链接");
  const destination = String(task.metadata.destination ?? "");
  if (!destination.startsWith("/")) {
    throw new Error("等待中的任务缺少有效目标目录");
  }
  const remoteTasks = await deps.openList.startOfflineDownload({
    path: destination,
    url: magnetUri,
  });
  const remote = remoteTasks[0];
  if (!remote) {
    throw new Error("OpenList 没有返回新的离线任务");
  }
  const updated = deps.tasks.update(task.id, {
    state: "running",
    progress: 0,
    statusText: "用户已选择备用资源，正在等待 115 秒传",
    externalId: remote.id,
    metadata: {
      ...task.metadata,
      sourceCandidateId: selected.id,
      attemptIndex: selectedIndex,
      attemptStartedAt: new Date().toISOString(),
      remoteName: remote.name,
      awaitingFallbackSelection: undefined,
    },
  });
  const upgrade = recordValue(task.metadata.mediaUpgrade);
  const upgradeItemId =
    typeof upgrade?.upgradeItemId === "string"
      ? upgrade.upgradeItemId
      : undefined;
  if (upgradeItemId) {
    deps.mediaUpgrades.update(upgradeItemId, {
      state: "downloading",
      error: "",
    });
  }
  return updated;
}

function downloadMetadata(
  deps: ToolDependencies,
  input: {
    candidates: DownloadCandidate[];
    unavailableFallbacks: Array<{
      reference: string;
      error: string;
    }>;
    title: string;
    target: MediaDestination;
    workflowId: string;
  },
  candidates: DownloadCandidate[],
  policy: { enabled: boolean; timeoutMs: number },
): Record<string, unknown> {
  return {
    ...taskMetadata(input.target),
    sourceCandidateId: candidates[0]?.id,
    downloadCandidates: candidates,
    unavailableFallbacks: input.unavailableFallbacks,
    attemptIndex: 0,
    attemptStartedAt: new Date().toISOString(),
    instantOfflinePolicy: policy,
    notificationTarget: deps.notificationTarget,
    completionContinuation: deps.notificationTarget
      ? {
          workflowId: input.workflowId,
          state: "pending",
          attempts: 0,
          nextAttemptAt: new Date().toISOString(),
        }
      : undefined,
  };
}

async function resolveDownloadCandidates(
  deps: ToolDependencies,
  args: Record<string, unknown>,
  taskTitle: string,
): Promise<{
  candidates: DownloadCandidate[];
  unavailableFallbacks: Array<{ reference: string; error: string }>;
}> {
  const candidateId =
    typeof args.release_candidate_id === "string"
      ? args.release_candidate_id.trim()
      : "";
  const directMagnet =
    typeof args.magnet_uri === "string" ? args.magnet_uri.trim() : "";
  if (Boolean(candidateId) === Boolean(directMagnet)) {
    throw new Error("release_candidate_id 与 magnet_uri 必须且只能提供一个");
  }
  const primary = candidateId
    ? await deps.jackett.resolveCandidate(candidateId)
    : directMagnetCandidate(
        normalizeMagnetUri(directMagnet, taskTitle),
        "用户提供的磁力资源",
      );
  const fallbackIds = optionalStringArray(
    args,
    "fallback_candidate_ids",
    8,
  );
  const fallbackMagnets = optionalStringArray(
    args,
    "fallback_magnet_uris",
    8,
  );
  const fallbackResolvers = [
    ...fallbackIds.map((id) => ({
      reference: id,
      resolve: () => deps.jackett.resolveCandidate(id),
    })),
    ...fallbackMagnets.map((magnet, index) => ({
      reference: `用户提供的备用资源 ${index + 1}`,
      resolve: async () =>
        directMagnetCandidate(
          normalizeMagnetUri(magnet, `${taskTitle} 备用 ${index + 1}`),
          `用户提供的备用资源 ${index + 1}`,
        ),
    })),
  ];
  const results = await Promise.allSettled(
    fallbackResolvers.map((entry) => entry.resolve()),
  );
  const resolvedFallbacks: DownloadCandidate[] = [];
  const unavailableFallbacks: Array<{ reference: string; error: string }> = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      resolvedFallbacks.push(result.value);
    } else {
      unavailableFallbacks.push({
        reference: fallbackResolvers[index]!.reference,
        error: result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      });
    }
  }
  return {
    candidates: uniqueDownloadCandidates([primary, ...resolvedFallbacks]),
    unavailableFallbacks,
  };
}

function legacyCandidateTitle(
  deps: ToolDependencies,
  task: { metadata: Record<string, unknown> },
  sourceUrl: string,
): string | undefined {
  const mediaUpgrade = task.metadata.mediaUpgrade;
  if (
    !mediaUpgrade ||
    typeof mediaUpgrade !== "object" ||
    Array.isArray(mediaUpgrade)
  ) {
    return undefined;
  }
  const itemId = (mediaUpgrade as Record<string, unknown>).upgradeItemId;
  if (typeof itemId !== "string") return undefined;
  return deps.mediaUpgrades
    .get(itemId)
    ?.candidates.find((candidate) => candidate.downloadUrl === sourceUrl)
    ?.title;
}

async function resolveTarget(
  deps: ToolDependencies,
  args: Record<string, unknown>,
): Promise<MediaDestination> {
  return resolveMediaDestination(
    deps.openList,
    deps.tmdb,
    parseMediaSelection(args),
  );
}

function parseMediaSelection(args: Record<string, unknown>): MediaSelection {
  const mediaType = requireString(args, "media_type");
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new Error("media_type 必须是 movie 或 tv");
  }
  const seasons = args.seasons;
  if (!Array.isArray(seasons) || seasons.length > 100) {
    throw new Error("seasons 必须是最多包含 100 项的数组");
  }
  return {
    mediaType: mediaType as DownloadMediaType,
    tmdbId: requireNumber(args, "tmdb_id"),
    seasons: seasons.map((season, index) => {
      if (typeof season !== "number" || !Number.isFinite(season)) {
        throw new Error(`seasons[${index}] 必须是数字`);
      }
      return season;
    }),
  };
}

function taskMetadata(target: MediaDestination): Record<string, unknown> {
  return {
    destination: target.destination,
    jellyfinRefreshPath: target.refreshPath,
    jellyfinProviderIds: target.providerIds,
    media: mediaSummary(target),
  };
}

function mediaSummary(target: MediaDestination): Record<string, unknown> {
  return {
    type: target.mediaType,
    tmdbId: target.tmdbId,
    title: target.mediaTitle,
    seasons: target.seasons,
    isMultiSeason: target.seasons.length > 1,
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
