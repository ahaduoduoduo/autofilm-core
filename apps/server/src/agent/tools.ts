import type { TaskStore } from "../db/task-store.js";
import type { JackettClient } from "../integrations/jackett.js";
import type { JellyfinClient } from "../integrations/jellyfin.js";
import type { OpenListClient } from "../integrations/openlist.js";
import type { TmdbClient } from "../integrations/tmdb.js";
import type { ToolDefinition } from "../ai/types.js";

export interface AgentTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface ToolDependencies {
  userId: string;
  notificationTarget?: {
    channel: string;
    providerInstanceId: string;
    targetId: string;
  };
  tasks: TaskStore;
  tmdb: TmdbClient;
  jackett: JackettClient;
  openList: OpenListClient;
  jellyfin: JellyfinClient;
  storageAuth?: {
    start(): Promise<unknown>;
  };
}

export function createAgentTools(deps: ToolDependencies): AgentTool[] {
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
          "在 Jackett 中搜索可下载版本。通常使用英文规范标题、年份和季集编号。",
        parameters: objectSchema(
          { query: stringProperty("发布版本搜索词") },
          ["query"],
        ),
      },
      execute: async (args) => deps.jackett.search(requireString(args, "query")),
    },
    {
      definition: {
        name: "start_offline_download",
        description:
          "在 OpenList 中创建离线下载。仅在用户已经明确选定内容和版本后调用。",
        parameters: objectSchema(
          {
            url: stringProperty("磁力链接或下载链接"),
            destination: stringProperty("OpenList 中的目标目录绝对路径"),
            title: stringProperty("任务显示名称"),
          },
          ["url", "destination", "title"],
        ),
      },
      execute: async (args) => {
        const url = requireString(args, "url");
        const destination = requireAbsolutePath(args, "destination");
        const title = requireString(args, "title");
        await deps.openList.mkdir(destination).catch((error: unknown) => {
          if (!String(error).toLowerCase().includes("exist")) throw error;
        });
        const remoteTasks = await deps.openList.startOfflineDownload({
          path: destination,
          url,
        });
        if (remoteTasks.length === 0) {
          return deps.tasks.create({
            userId: deps.userId,
            type: "offline-download",
            title,
            state: "waiting",
            metadata: {
              destination,
              sourceUrl: url,
              notificationTarget: deps.notificationTarget,
            },
          });
        }
        return remoteTasks.map((remoteTask) =>
          deps.tasks.create({
            userId: deps.userId,
            type: "offline-download",
            title,
            state: "running",
            externalId: remoteTask.id,
            metadata: {
              destination,
              sourceUrl: url,
              remoteName: remoteTask.name,
              notificationTarget: deps.notificationTarget,
            },
          }),
        );
      },
    },
    {
      definition: {
        name: "list_download_tasks",
        description: "查看当前成员最近的离线下载任务和进度。",
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
          "明确通知 Jellyfin 刷新一个 OpenList 绝对路径。离线下载完成或管理员要求时使用。",
        parameters: objectSchema(
          {
            path: stringProperty("/ 开头的 OpenList 媒体路径"),
            recursive: { type: "boolean", description: "是否递归刷新" },
            tmdb_id: {
              type: "string",
              description: "已确认影片身份时提供 TMDB ID",
            },
            imdb_id: {
              type: "string",
              description: "已确认影片身份时提供 IMDb ID",
            },
            force_probe: {
              type: "boolean",
              description: "是否强制重新探测音视频流；新文件通常不需要",
            },
          },
          ["path"],
        ),
      },
      execute: async (args) => {
        const path = requireAbsolutePath(args, "path");
        const providerIds: Record<string, string> = {};
        if (typeof args.tmdb_id === "string" && args.tmdb_id) {
          providerIds.Tmdb = args.tmdb_id;
        }
        if (typeof args.imdb_id === "string" && args.imdb_id) {
          providerIds.Imdb = args.imdb_id;
        }
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
          "为管理员启动 OpenList 网盘扫码登录，并通过当前聊天发送二维码。仅在管理员明确要求重新登录或凭据失效时调用。",
        parameters: objectSchema({}),
      },
      execute: async () => deps.storageAuth!.start(),
    });
  }
  return tools;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function requireAbsolutePath(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = requireString(args, key);
  if (!value.startsWith("/") || value.includes("..")) {
    throw new Error(`${key} must be a safe absolute OpenList path`);
  }
  return value.replace(/\/+/g, "/");
}
