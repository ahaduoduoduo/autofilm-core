import {
  resolveMediaDestination,
  type DownloadMediaType,
  type MediaDestination,
  type MediaSelection,
} from "../media-destination.js";
import type { AgentTool, ToolDependencies } from "../tool-types.js";
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
            url: stringProperty("磁力链接或下载链接"),
            fallback_urls: {
              type: "array",
              maxItems: 8,
              items: { type: "string" },
              description:
                "同一内容的备用磁力链接，按优先级排列；115 秒传超时后自动尝试",
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
            "url",
            "fallback_urls",
            "media_type",
            "tmdb_id",
            "seasons",
            "title",
          ],
        ),
      },
      execute: async (args) => {
        const target = await resolveTarget(deps, args);
        return startDownload(deps, {
          url: requireString(args, "url"),
          fallbackUrls: optionalStringArray(args, "fallback_urls", 8),
          title: requireString(args, "title"),
          target,
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
                  url: stringProperty("磁力链接或下载链接"),
                  fallback_urls: {
                    type: "array",
                    maxItems: 8,
                    items: { type: "string" },
                    description: "这一项的备用磁力链接，按优先级排列",
                  },
                  title: stringProperty("任务名称"),
                },
                required: ["url", "fallback_urls", "title"],
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
        const results: unknown[] = [];
        for (const [index, value] of downloads.entries()) {
          if (typeof value !== "object" || !value) {
            throw new Error(`downloads[${index}] 格式无效`);
          }
          const item = value as Record<string, unknown>;
          results.push(
            await startDownload(deps, {
              url: requireString(item, "url"),
              fallbackUrls: optionalStringArray(item, "fallback_urls", 8),
              title: requireString(item, "title"),
              target,
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
  ];
}

async function startDownload(
  deps: ToolDependencies,
  input: {
    url: string;
    fallbackUrls?: string[];
    title: string;
    target: MediaDestination;
  },
): Promise<unknown> {
  const candidates = uniqueUrls([input.url, ...(input.fallbackUrls ?? [])]);
  const policy = deps.openList.instantOfflinePolicy();
  await deps.openList.mkdir(input.target.destination);
  const remoteTasks = await deps.openList.startOfflineDownload({
    path: input.target.destination,
    url: input.url,
  });
  if (remoteTasks.length === 0) {
    return deps.tasks.create({
      userId: deps.userId,
      type: "offline-download",
      title: input.title,
      state: "waiting",
      metadata: {
        ...taskMetadata(input.target),
        sourceUrl: candidates[0],
        candidateUrls: candidates,
        attemptIndex: 0,
        attemptStartedAt: new Date().toISOString(),
        instantOfflinePolicy: policy,
        notificationTarget: deps.notificationTarget,
      },
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
        ...taskMetadata(input.target),
        sourceUrl: candidates[0],
        candidateUrls: candidates,
        attemptIndex: 0,
        attemptStartedAt: new Date().toISOString(),
        instantOfflinePolicy: policy,
        remoteName: remoteTask.name,
        notificationTarget: deps.notificationTarget,
      },
    }),
  );
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

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => url.trim()).filter(Boolean))].slice(0, 9);
}
