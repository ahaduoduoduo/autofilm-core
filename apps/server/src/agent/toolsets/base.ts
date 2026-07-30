import type { AgentTool, ToolDependencies } from "../tool-types.js";
import {
  objectSchema,
  requireAbsolutePath,
  requireNumber,
  requireString,
  stringProperty,
} from "./schema.js";

export function createBaseTools(deps: ToolDependencies): AgentTool[] {
  const tools: AgentTool[] = [
    ...(deps.mediaTopic
      ? [{
          definition: {
            name: "set_active_media_topic",
            description:
              "在当前讨论焦点已经唯一确定为一部电影或电视剧后登记主题。切换到另一作品时，Core 会把上一作品的完整历史压缩为摘要；只是举例或同时比较多部作品时不要调用。",
            parameters: objectSchema(
              {
                media_type: {
                  type: "string",
                  enum: ["movie", "tv"],
                },
                tmdb_id: {
                  type: "integer",
                  minimum: 1,
                },
                title: stringProperty("已确认的规范标题"),
                production_year: {
                  type: "integer",
                  minimum: 1800,
                  maximum: 3000,
                },
              },
              ["media_type", "tmdb_id", "title"],
            ),
          },
          execute: async (args: Record<string, unknown>) => {
            const mediaType = requireString(args, "media_type");
            if (mediaType !== "movie" && mediaType !== "tv") {
              throw new Error("media_type must be movie or tv");
            }
            return deps.mediaTopic!.activate({
              mediaType,
              tmdbId: positiveInteger(args, "tmdb_id", 1),
              title: requireString(args, "title"),
              productionYear:
                args.production_year === undefined
                  ? undefined
                  : positiveInteger(args, "production_year", 1800),
            });
          },
        } satisfies AgentTool]
      : []),
    {
      definition: {
        name: "search_catalog",
        description:
          "按名称搜索 TMDB 电影和电视剧，获取规范标题、年份、类型和 TMDB ID。",
        parameters: objectSchema(
          { query: stringProperty("影片或剧集名称") },
          ["query"],
        ),
      },
      execute: async (args) => deps.tmdb.search(requireString(args, "query")),
    },
    {
      definition: {
        name: "browse_trending",
        description: "获取本周热门电影和电视剧。",
        parameters: objectSchema({}),
      },
      execute: async () => deps.tmdb.trending(),
    },
    {
      definition: {
        name: "get_tmdb_metadata",
        description:
          "读取 TMDB 的电影、剧集整体、单季或单集评分、评分人数、剧情简介和播出日期。先用 search_catalog 确认真实 TMDB ID。",
        parameters: objectSchema(
          {
            media_type: {
              type: "string",
              enum: ["movie", "tv"],
              description: "电影使用 movie，电视剧使用 tv",
            },
            tmdb_id: {
              type: "integer",
              minimum: 1,
              description: "search_catalog 返回的 TMDB ID",
            },
            season_number: {
              type: "integer",
              minimum: 0,
              description: "可选季号；特别篇通常为第 0 季",
            },
            episode_number: {
              type: "integer",
              minimum: 1,
              description: "可选集号；指定时必须同时指定季号",
            },
          },
          ["media_type", "tmdb_id"],
        ),
      },
      execute: async (args) => {
        const mediaType = requireString(args, "media_type");
        if (mediaType !== "movie" && mediaType !== "tv") {
          throw new Error("media_type must be movie or tv");
        }
        const tmdbId = positiveInteger(args, "tmdb_id", 1);
        const seasonNumber =
          args.season_number === undefined
            ? undefined
            : positiveInteger(args, "season_number", 0);
        const episodeNumber =
          args.episode_number === undefined
            ? undefined
            : positiveInteger(args, "episode_number", 1);
        return deps.tmdb.metadata({
          mediaType,
          tmdbId,
          seasonNumber,
          episodeNumber,
        });
      },
    },
    {
      definition: {
        name: "search_releases",
        description:
          "在 Jackett 中搜索可下载版本。全部结果按文件大小从大到小排列，每页 20 条；需要查看更多时增加 page。",
        parameters: objectSchema(
          {
            query: stringProperty("发布版本搜索词"),
            page: {
              type: "integer",
              minimum: 0,
              description: "页码，从 0 开始；首次搜索使用 0",
            },
          },
          ["query"],
        ),
      },
      execute: async (args) =>
        deps.jackett.search(
          requireString(args, "query"),
          args.page === undefined ? 0 : requireNumber(args, "page"),
        ),
    },
    {
      definition: {
        name: "list_download_tasks",
        description:
          "查看当前成员最近的离线下载任务和进度。用户在下载后回复备用资源序号、名称或确认使用备用资源时必须先调用。",
        parameters: objectSchema({}),
      },
      execute: async () =>
        deps.tasks.list(50).filter((task) => task.userId === deps.userId),
    },
    {
      definition: {
        name: "search_jellyfin",
        description: "搜索 Jellyfin 中已经存在的电影、剧集和单集。",
        parameters: objectSchema(
          { query: stringProperty("媒体名称") },
          ["query"],
        ),
      },
      execute: async (args) => deps.jellyfin.search(requireString(args, "query")),
    },
    {
      definition: {
        name: "refresh_jellyfin_remote_path",
        description:
          "手工通知 Jellyfin 刷新一个 OpenList 绝对路径。自动下载完成后无需调用。",
        parameters: objectSchema(
          {
            path: stringProperty("/ 开头的 OpenList 媒体路径"),
            recursive: { type: "boolean", description: "是否递归刷新" },
            tmdb_id: { type: "string", description: "可选 TMDB ID" },
            imdb_id: { type: "string", description: "可选 IMDb ID" },
            force_probe: {
              type: "boolean",
              description: "是否强制重新探测音视频流",
            },
          },
          ["path"],
        ),
      },
      execute: async (args) => {
        const path = requireAbsolutePath(args, "path");
        const providerIds: Record<string, string> = {};
        if (typeof args.tmdb_id === "string" && args.tmdb_id)
          providerIds.Tmdb = args.tmdb_id;
        if (typeof args.imdb_id === "string" && args.imdb_id)
          providerIds.Imdb = args.imdb_id;
        await deps.jellyfin.remoteRefresh({
          path,
          recursive: args.recursive !== false,
          forceProbe: args.force_probe === true,
          providerIds:
            Object.keys(providerIds).length > 0 ? providerIds : undefined,
        });
        return { refreshed: true, path };
      },
    },
    {
      definition: {
        name: "get_current_time",
        description: "获取服务端当前日期和时间。",
        parameters: objectSchema({}),
      },
      execute: async () => {
        const now = new Date();
        return {
          iso: now.toISOString(),
          local: now.toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
          }),
          timeZone: "Asia/Shanghai",
        };
      },
    },
  ];
  if (deps.storageAuth) {
    tools.push({
      definition: {
        name: "start_openlist_storage_auth",
        description:
          "为管理员启动 OpenList 网盘扫码登录，并通过当前聊天发送二维码。",
        parameters: objectSchema({}),
      },
      execute: async () => deps.storageAuth!.start(),
    });
  }
  return tools;
}

function positiveInteger(
  args: Record<string, unknown>,
  key: string,
  minimum: number,
): number {
  const value = requireNumber(args, key);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${key} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}
