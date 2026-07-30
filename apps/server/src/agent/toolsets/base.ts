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
      execute: async () => ({
        iso: new Date().toISOString(),
        local: new Date().toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
        }),
      }),
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
