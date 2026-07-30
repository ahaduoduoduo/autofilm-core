import type { ConfigStore } from "../db/config-store.js";
import type { ConversationStore } from "../db/conversation-store.js";
import type { TaskStore } from "../db/task-store.js";
import type { UserStore } from "../db/user-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { EphemeralMediaStore } from "../db/media-store.js";
import type { PromptStore } from "../db/prompt-store.js";
import { createAiClient } from "../ai/client.js";
import type { CanonicalMessage } from "../ai/types.js";
import type { JackettClient } from "../integrations/jackett.js";
import type { JellyfinClient } from "../integrations/jellyfin.js";
import type { OpenListClient } from "../integrations/openlist.js";
import type { TmdbClient } from "../integrations/tmdb.js";
import type { SubHDClient } from "../integrations/subhd.js";
import type { WatchlistStore } from "../db/watchlist-store.js";
import type { SubtitleWorkspaceStore } from "../subtitles/workspace-store.js";
import type { SubtitleDownloadService } from "../subtitles/download-service.js";
import type { SubtitleCleaner } from "../subtitles/cleaner.js";
import { createAgentTools } from "./tools.js";
import { executeToolCalls } from "./tool-executor.js";

export interface AgentDependencies {
  configs: ConfigStore;
  prompts: PromptStore;
  conversations: ConversationStore;
  tasks: TaskStore;
  tmdb: TmdbClient;
  jackett: JackettClient;
  openList: OpenListClient;
  jellyfin: JellyfinClient;
  subhd: SubHDClient;
  watchlists: WatchlistStore;
  subtitleWorkspaces: SubtitleWorkspaceStore;
  subtitleDownloads: SubtitleDownloadService;
  subtitleCleaner: SubtitleCleaner;
  users: UserStore;
  outbox: OutboxStore;
  media: EphemeralMediaStore;
  mediaBaseUrl: string;
}

export class AgentService {
  constructor(private readonly deps: AgentDependencies) {}

  async respond(input: {
    userId: string;
    channel: string;
    providerInstanceId: string;
    externalConversationId: string;
    text: string;
  }): Promise<string> {
    const model = this.deps.configs.defaultModel();
    if (!model) {
      throw new Error("No enabled default AI model is configured");
    }
    const provider = this.deps.configs.provider(model.providerId);
    if (!provider || !provider.enabled) {
      throw new Error("The default AI provider is unavailable");
    }
    const conversationId = this.deps.conversations.getOrCreate(input);
    const userMessage: CanonicalMessage = {
      role: "user",
      content: input.text,
    };
    this.deps.conversations.append(conversationId, userMessage);
    const sessionUser = this.deps.users.sessionUser(input.userId);
    const openListConfig = this.deps.configs.service("openlist");
    const storageId = Number(openListConfig?.options.authStorageId);
    const notificationTarget =
      input.channel === "web"
        ? undefined
        : {
            channel: input.channel,
            providerInstanceId: input.providerInstanceId,
            targetId: input.externalConversationId,
          };

    const storageAuth =
      sessionUser &&
        ["owner", "admin"].includes(sessionUser.role) &&
        notificationTarget &&
        Number.isInteger(storageId) &&
        storageId > 0
        ? {
            start: async () => {
              const session = await this.deps.openList.startAuth(storageId);
              const qrCode = await this.deps.openList.authQrCode(
                storageId,
                session.session_id,
              );
              const token = this.deps.media.create({
                content: qrCode,
                contentType: "image/png",
                fileName: "openlist-auth.png",
                expiresAt: new Date(session.expires_at),
              });
              this.deps.outbox.enqueueMessages({
                userId: input.userId,
                ...notificationTarget,
                messages: [
                  {
                    type: "text" as const,
                    text: "请使用 115 客户端扫描下方二维码。登录信息将由 OpenList 自动更新。",
                  },
                  {
                    type: "image" as const,
                    media_url: `${this.deps.mediaBaseUrl}/v1/media/${token}`,
                    file_name: "openlist-auth.png",
                  },
                ],
              });
              return {
                state: session.state,
                expiresAt: session.expires_at,
                message: "二维码已发送到当前聊天",
              };
            },
          }
        : undefined;
    const tools = this.createTools(
      input.userId,
      notificationTarget,
      storageAuth,
    );
    const client = createAiClient(provider.protocol, {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      headers: provider.customHeaders,
    });

    for (let iteration = 0; iteration < 12; iteration += 1) {
      const history = this.deps.conversations.history(conversationId);
      const result = await client.generate({
        model: model.model,
        messages: [
          { role: "system", content: this.deps.prompts.get("agent.main") },
          ...history,
        ],
        tools: tools.map((tool) => tool.definition),
        temperature: model.temperature,
        maxOutputTokens: model.maxOutputTokens,
      });

      if (result.toolCalls.length === 0) {
        const content = result.content.trim() || "任务已处理，但模型没有返回文本。";
        this.deps.conversations.append(conversationId, {
          role: "assistant",
          content,
        });
        return content;
      }

      this.deps.conversations.append(conversationId, {
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls,
      });
      const toolResults = await executeToolCalls(result.toolCalls, tools);
      for (const { call, content } of toolResults) {
        this.deps.conversations.append(conversationId, {
          role: "tool",
          content: formatToolResult(call.name, content),
          toolCallId: call.id,
        });
      }
    }
    throw new Error("Agent exceeded the maximum tool iteration count");
  }

  reset(input: {
    userId: string;
    channel: string;
    providerInstanceId: string;
    externalConversationId: string;
  }): void {
    this.deps.conversations.reset(input);
  }

  async evaluateWatchlist(input: {
    userId: string;
    title: string;
    originalTitle: string;
    season: number;
    episodeNumbers: number[];
    conditions: string;
  }): Promise<string> {
    const model = this.deps.configs.defaultModel();
    if (!model) throw new Error("No enabled default AI model is configured");
    const provider = this.deps.configs.provider(model.providerId);
    if (!provider || !provider.enabled) {
      throw new Error("The default AI provider is unavailable");
    }
    const allowed = new Set([
      "search_catalog",
      "search_releases",
      "search_subtitle",
      "get_subtitle_detail",
      "search_jellyfin",
      "list_jellyfin_episodes",
      "get_jellyfin_media_info",
      "get_current_time",
    ]);
    const tools = this.createTools(input.userId).filter((tool) =>
      allowed.has(tool.definition.name),
    );
    const client = createAiClient(provider.protocol, {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      headers: provider.customHeaders,
    });
    const messages: CanonicalMessage[] = [
      {
        role: "system",
        content: this.deps.prompts.get("watchlist.evaluator"),
      },
      {
        role: "user",
        content:
          `剧集：${input.title} / ${input.originalTitle}\n` +
          `季：S${String(input.season).padStart(2, "0")}\n` +
          `分集：${input.episodeNumbers.map((value) => `E${String(value).padStart(2, "0")}`).join(", ")}\n` +
          `条件：${input.conditions || "有可用发布版本"}`,
      },
    ];
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const response = await client.generate({
        model: model.model,
        messages,
        tools: tools.map((tool) => tool.definition),
        temperature: 0,
        maxOutputTokens: Math.min(model.maxOutputTokens ?? 4096, 4096),
      });
      if (response.toolCalls.length === 0) return response.content;
      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });
      const toolResults = await executeToolCalls(response.toolCalls, tools);
      for (const { call, content } of toolResults) {
        messages.push({
          role: "tool",
          content: formatToolResult(call.name, content),
          toolCallId: call.id,
        });
      }
    }
    throw new Error("Watchlist evaluator exceeded the tool iteration limit");
  }

  async testModel(input: {
    modelId: string;
    message: string;
  }): Promise<{
    content: string;
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
  }> {
    const model = this.deps.configs.model(input.modelId);
    if (!model) throw new Error("Model profile not found");
    const provider = this.deps.configs.provider(model.providerId);
    if (!provider) throw new Error("AI provider not found");
    const client = createAiClient(provider.protocol, {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      headers: provider.customHeaders,
    });
    const started = Date.now();
    const response = await client.generate({
      model: model.model,
      messages: [{ role: "user", content: input.message }],
      temperature: model.temperature,
      maxOutputTokens: model.maxOutputTokens,
    });
    return {
      content: response.content,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      elapsedMs: Date.now() - started,
    };
  }

  private createTools(
    userId: string,
    notificationTarget?: {
      channel: string;
      providerInstanceId: string;
      targetId: string;
    },
    storageAuth?: { start(): Promise<unknown> },
  ) {
    return createAgentTools({
      userId,
      notificationTarget,
      tasks: this.deps.tasks,
      tmdb: this.deps.tmdb,
      jackett: this.deps.jackett,
      openList: this.deps.openList,
      jellyfin: this.deps.jellyfin,
      subhd: this.deps.subhd,
      watchlists: this.deps.watchlists,
      subtitleWorkspaces: this.deps.subtitleWorkspaces,
      subtitleDownloads: this.deps.subtitleDownloads,
      subtitleCleaner: this.deps.subtitleCleaner,
      outbox: this.deps.outbox,
      media: this.deps.media,
      mediaBaseUrl: this.deps.mediaBaseUrl,
      storageAuth,
    });
  }
}

function truncate(value: string, length: number): string {
  return value.length > length
    ? `${value.slice(0, length)}…[truncated]`
    : value;
}

export function formatToolResult(toolName: string, content: string): string {
  if (
    toolName === "search_subtitle" ||
    toolName === "get_subtitle_detail" ||
    toolName === "get_subtitle_workspace"
  ) {
    return content;
  }
  return truncate(content, 24_000);
}
