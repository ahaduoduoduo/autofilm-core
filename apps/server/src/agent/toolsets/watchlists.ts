import type { AgentTool, ToolDependencies } from "../tool-types.js";
import {
  objectSchema,
  optionalString,
  requireAbsolutePath,
  requireNumber,
  requireString,
  stringProperty,
} from "./schema.js";

export function createWatchlistTools(deps: ToolDependencies): AgentTool[] {
  return [
    {
      definition: {
        name: "add_watchlist",
        description:
          "添加按成员隔离的剧集追更。使用 search_catalog 返回的稳定 TMDB ID；调用前必须获得用户同意。",
        parameters: objectSchema(
          {
            tmdb_id: { type: "number", description: "TMDB 剧集 ID" },
            title: stringProperty("剧集显示名称"),
            original_title: stringProperty("英文或原始标题"),
            season: { type: "number", minimum: 0 },
            conditions: stringProperty("资源、画质或字幕条件；可留空"),
            destination: stringProperty("该季的 OpenList 目标目录"),
          },
          ["tmdb_id", "title", "season", "destination"],
        ),
      },
      execute: async (args) => {
        const tmdbId = requireNumber(args, "tmdb_id");
        const seasonNumber = requireNumber(args, "season");
        if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
          throw new Error("tmdb_id 必须是正整数");
        }
        if (!Number.isInteger(seasonNumber) || seasonNumber < 0) {
          throw new Error("season 必须是非负整数");
        }
        const detail = await deps.tmdb.season(tmdbId, seasonNumber);
        return deps.watchlists.add({
          userId: deps.userId,
          tmdbId,
          title: requireString(args, "title"),
          originalTitle:
            optionalString(args, "original_title") ??
            requireString(args, "title"),
          season: seasonNumber,
          conditions:
            typeof args.conditions === "string" ? args.conditions.trim() : "",
          destination: requireAbsolutePath(args, "destination"),
          episodes: detail.episodes.map((episode) => ({
            episodeNumber: episode.episodeNumber,
            airDate: episode.airDate,
          })),
          notificationTarget: deps.notificationTarget,
        });
      },
    },
    {
      definition: {
        name: "list_watchlist",
        description: "查看当前成员的追更列表和各集状态。",
        parameters: objectSchema({}),
      },
      execute: async () => deps.watchlists.list(deps.userId),
    },
    {
      definition: {
        name: "remove_watchlist",
        description: "删除当前成员的一个追更项。",
        parameters: objectSchema(
          { watchlist_id: stringProperty("list_watchlist 返回的 ID") },
          ["watchlist_id"],
        ),
      },
      execute: async (args) => {
        const id = requireString(args, "watchlist_id");
        return { id, removed: deps.watchlists.remove(deps.userId, id) };
      },
    },
  ];
}
