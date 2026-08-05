import type { ModelProfile } from "@autofilm/contracts";
import type { ConfigStore } from "../db/config-store.js";
import type {
  ConversationStore,
  MediaTopic,
  TopicSummary,
} from "../db/conversation-store.js";
import type { TaskStore } from "../db/task-store.js";
import type { UserStore } from "../db/user-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { EphemeralMediaStore } from "../db/media-store.js";
import type { PromptStore } from "../db/prompt-store.js";
import { createAiClient } from "../ai/client.js";
import type {
  AiClient,
  CanonicalMessage,
  ToolDefinition,
} from "../ai/types.js";
import {
  contextBudgetPolicy,
  estimateGenerateRequestTokens,
  limitToolOutputs,
} from "../ai/token-budget.js";
import type { JackettClient } from "../integrations/jackett.js";
import type { MediaUpgradeStore } from "../db/media-upgrade-store.js";
import type { MediaUpgradeCheckStore } from "../db/media-upgrade-check-store.js";
import type { UserMemoryStore } from "../db/user-memory-store.js";
import type { JellyfinClient } from "../integrations/jellyfin.js";
import type { OpenListClient } from "../integrations/openlist.js";
import type { CatalogItem, TmdbClient } from "../integrations/tmdb.js";
import type { SubHDClient } from "../integrations/subhd.js";
import type { WatchlistStore } from "../db/watchlist-store.js";
import type { SubtitleWorkspaceStore } from "../subtitles/workspace-store.js";
import type { SubtitleDownloadService } from "../subtitles/download-service.js";
import type { SubtitleCleaner } from "../subtitles/cleaner.js";
import { createAgentTools } from "./tools.js";
import { executeToolCalls } from "./tool-executor.js";
import { ConversationQueue } from "./conversation-queue.js";
import { LocalContextCompactor } from "./context-compactor.js";
import { formatConversationTranscript } from "./conversation-transcript.js";
import {
  rememberCatalogResults,
  selectedCatalogItem,
} from "./catalog-poster.js";

export interface AgentDependencies {
  configs: ConfigStore;
  prompts: PromptStore;
  conversations: ConversationStore;
  tasks: TaskStore;
  mediaUpgrades: MediaUpgradeStore;
  mediaUpgradeChecks: MediaUpgradeCheckStore;
  userMemories: UserMemoryStore;
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
  private readonly conversationQueue = new ConversationQueue();
  private readonly contextCompactor: LocalContextCompactor;

  constructor(private readonly deps: AgentDependencies) {
    this.contextCompactor = new LocalContextCompactor(
      deps.conversations,
      deps.prompts,
    );
  }

  async respond(input: {
    userId: string;
    channel: string;
    providerInstanceId: string;
    externalConversationId: string;
    text: string;
  }): Promise<string> {
    return this.conversationQueue.run(conversationKey(input), () =>
      this.respondInConversation(input),
    );
  }

  private async respondInConversation(input: {
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
    const currentTurn = this.deps.conversations.append(
      conversationId,
      userMessage,
    );
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
    const client = createAiClient(provider.protocol, {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      headers: provider.customHeaders,
    });
    const tools = this.createTools(
      input.userId,
      notificationTarget,
      storageAuth,
      {
        activate: (topic) =>
          this.activateMediaTopic({
            conversationId,
            currentTurnMessageId: currentTurn.id,
            topic,
            client,
            model: model.model,
            maxOutputTokens: model.maxOutputTokens,
          }),
      },
    );
    const catalogItems = new Map<number, CatalogItem>();
    let observedInputTokens = 0;

    for (let iteration = 0; iteration < 12; iteration += 1) {
      const messages = await this.prepareAgentMessages({
        conversationId,
        userId: input.userId,
        client,
        model,
        tools: tools.map((tool) => tool.definition),
        observedInputTokens,
      });
      const result = await client.generate({
        model: model.model,
        messages,
        tools: tools.map((tool) => tool.definition),
        temperature: model.temperature,
        maxOutputTokens: model.maxOutputTokens,
      });
      observedInputTokens = result.usage.inputTokens;

      if (result.toolCalls.length === 0) {
        const content = result.content.trim() || "任务已处理，但模型没有返回文本。";
        this.deps.conversations.append(conversationId, {
          role: "assistant",
          content,
        });
        return this.withCatalogPoster(content, catalogItems);
      }

      this.deps.conversations.append(conversationId, {
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls,
      });
      const toolResults = await executeToolCalls(result.toolCalls, tools);
      for (const { call, content } of toolResults) {
        rememberCatalogResults(call.name, content, catalogItems);
        this.deps.conversations.append(conversationId, {
          role: "tool",
          content,
          toolCallId: call.id,
        });
      }
    }
    const messages = await this.prepareAgentMessages({
      conversationId,
      userId: input.userId,
      client,
      model,
      tools: [],
      observedInputTokens,
      finalResponse: true,
    });
    const finalResult = await client.generate({
      model: model.model,
      messages: [
        {
          role: "system",
          content: `${messages[0]?.content ?? ""}\n\n` +
            "本次请求已经达到工具轮次边界。不得继续调用工具。根据已有工具结果说明" +
            "哪些项目已经成功、哪些失败、哪些尚未执行；不得把内部轮次边界或未执行项" +
            "描述为业务成功。",
        },
        ...messages.slice(1),
      ],
      temperature: model.temperature,
      maxOutputTokens: model.maxOutputTokens,
    });
    const content =
      finalResult.content.trim() ||
      "本次仅完成了部分操作；已完成状态保留，请继续处理尚未执行的项目。";
    this.deps.conversations.append(conversationId, {
      role: "assistant",
      content,
    });
    return this.withCatalogPoster(content, catalogItems);
  }

  private async withCatalogPoster(
    content: string,
    catalogItems: Map<number, CatalogItem>,
  ): Promise<string> {
    const item = selectedCatalogItem(content, catalogItems);
    if (!item?.posterPath) return content;
    try {
      const poster = await this.deps.tmdb.poster(item.posterPath);
      const token = this.deps.media.create({
        content: poster.data,
        contentType: poster.contentType,
        fileName: `tmdb-${item.id}-poster.jpg`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        reads: 10,
      });
      return `${this.deps.mediaBaseUrl}/v1/media/${token}\n\n${content}`;
    } catch {
      return content;
    }
  }

  async reset(input: {
    userId: string;
    channel: string;
    providerInstanceId: string;
    externalConversationId: string;
  }): Promise<void> {
    await this.conversationQueue.run(conversationKey(input), async () => {
      this.deps.conversations.reset(input);
    });
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
        content: runtimeSystemPrompt(
          this.deps.prompts.get("watchlist.evaluator"),
        ),
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
    const policy = contextBudgetPolicy(model);
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const response = await client.generate({
        model: model.model,
        messages: limitToolOutputs(messages, policy.toolOutputTokenLimit),
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
          content,
          toolCallId: call.id,
        });
      }
    }
    throw new Error("Watchlist evaluator exceeded the tool iteration limit");
  }

  private async prepareAgentMessages(input: {
    conversationId: string;
    userId: string;
    client: AiClient;
    model: ModelProfile;
    tools: ToolDefinition[];
    observedInputTokens: number;
    finalResponse?: boolean;
  }): Promise<CanonicalMessage[]> {
    const policy = contextBudgetPolicy(input.model);
    const build = () => {
      const context = this.deps.conversations.modelHistory(
        input.conversationId,
        { toolOutputTokenLimit: policy.toolOutputTokenLimit },
      );
      return [
        {
          role: "system" as const,
          content: runtimeSystemPrompt(
            this.deps.prompts.get("agent.main"),
            combinedMemory(
              this.deps.userMemories.prompt(input.userId),
              context.memory,
            ),
          ),
        },
        ...context.messages,
      ];
    };
    let messages = build();
    const estimatedTokens = estimateGenerateRequestTokens(
      messages,
      input.tools,
    );
    if (
      Math.max(estimatedTokens, input.observedInputTokens) <
      policy.autoCompactTokenLimit
    ) {
      return messages;
    }

    try {
      const result = await this.contextCompactor.compact({
        conversationId: input.conversationId,
        client: input.client,
        model: input.model,
        policy,
      });
      if (result.compacted) {
        messages = build();
      }
    } catch (error) {
      console.warn("AutoFilm local context compaction failed", {
        conversationId: input.conversationId,
        finalResponse: Boolean(input.finalResponse),
        error: error instanceof Error ? error.message : String(error),
      });
      if (estimatedTokens >= Math.floor(policy.contextWindowTokens * 0.95)) {
        throw new Error(
          `会话接近模型上下文上限且本地压缩失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const preparedTokens = estimateGenerateRequestTokens(messages, input.tools);
    if (preparedTokens >= Math.floor(policy.contextWindowTokens * 0.95)) {
      throw new Error(
        `本地压缩后上下文仍需要约 ${preparedTokens.toLocaleString()} Token，` +
        `已接近配置窗口 ${policy.contextWindowTokens.toLocaleString()} Token`,
      );
    }
    return messages;
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
    mediaTopic?: {
      activate(topic: MediaTopic): Promise<unknown>;
    },
  ) {
    return createAgentTools({
      userId,
      notificationTarget,
      tasks: this.deps.tasks,
      mediaUpgrades: this.deps.mediaUpgrades,
      mediaUpgradeChecks: this.deps.mediaUpgradeChecks,
      userMemories: this.deps.userMemories,
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
      mediaTopic,
    });
  }

  private async activateMediaTopic(input: {
    conversationId: string;
    currentTurnMessageId: string;
    topic: MediaTopic;
    client: AiClient;
    model: string;
    maxOutputTokens: number | null;
  }): Promise<Record<string, unknown>> {
    const plan = this.deps.conversations.planTopicSwitch(
      input.conversationId,
      input.topic,
      input.currentTurnMessageId,
    );
    if (!plan.changed) {
      return {
        changed: false,
        activeTopic: input.topic,
        message: "当前已经是该影视主题",
      };
    }

    let previous = plan.previous;
    if (previous && plan.messages.length > 0) {
      previous = {
        ...previous,
        summary: await this.summarizeTopic(
          input,
          previous,
          plan.messages,
        ),
      };
    }
    this.deps.conversations.commitTopicSwitch(
      input.conversationId,
      input.topic,
      input.currentTurnMessageId,
      previous,
    );
    return {
      changed: true,
      activeTopic: input.topic,
      archivedTopic: previous
        ? {
            mediaType: previous.mediaType,
            tmdbId: previous.tmdbId,
            title: previous.title,
          }
        : undefined,
    };
  }

  private async summarizeTopic(
    input: {
      client: AiClient;
      model: string;
      maxOutputTokens: number | null;
    },
    previous: TopicSummary,
    messages: CanonicalMessage[],
  ): Promise<string> {
    const transcript = formatConversationTranscript(messages);
    const result = await input.client.generate({
      model: input.model,
      messages: [
        {
          role: "system",
          content: this.deps.prompts.get("conversation.summarizer"),
        },
        {
          role: "user",
          content:
            `作品：${previous.title}\n` +
            `媒体类型：${previous.mediaType}\n` +
            `TMDB ID：${previous.tmdbId}\n\n` +
            `此前摘要：\n${previous.summary || "无"}\n\n` +
            `本次归档对话：\n${transcript}`,
        },
      ],
      temperature: 0,
      maxOutputTokens: Math.min(input.maxOutputTokens ?? 2_000, 2_000),
    });
    const summary = result.content.trim();
    if (!summary) throw new Error("影视主题摘要模型没有返回内容");
    return summary;
  }
}

function conversationKey(input: {
  userId: string;
  channel: string;
  providerInstanceId: string;
  externalConversationId: string;
}): string {
  return JSON.stringify([
    input.userId,
    input.channel,
    input.providerInstanceId,
    input.externalConversationId,
  ]);
}

function runtimeSystemPrompt(base: string, memory = ""): string {
  const now = new Date();
  const local = now.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  return [
    base,
    "## 当前运行时间",
    `服务器时间：${local}（Asia/Shanghai）`,
    `ISO 时间：${now.toISOString()}`,
    memory,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function combinedMemory(...values: string[]): string {
  return values.filter(Boolean).join("\n\n");
}
