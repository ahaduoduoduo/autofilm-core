import type { ConfigStore } from "../db/config-store.js";
import type { ConversationStore } from "../db/conversation-store.js";
import type { TaskStore } from "../db/task-store.js";
import type { UserStore } from "../db/user-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { EphemeralMediaStore } from "../db/media-store.js";
import { createAiClient } from "../ai/client.js";
import type { CanonicalMessage } from "../ai/types.js";
import type { JackettClient } from "../integrations/jackett.js";
import type { JellyfinClient } from "../integrations/jellyfin.js";
import type { OpenListClient } from "../integrations/openlist.js";
import type { TmdbClient } from "../integrations/tmdb.js";
import { AGENT_SYSTEM_PROMPT } from "./prompt.js";
import { createAgentTools } from "./tools.js";

export interface AgentDependencies {
  configs: ConfigStore;
  conversations: ConversationStore;
  tasks: TaskStore;
  tmdb: TmdbClient;
  jackett: JackettClient;
  openList: OpenListClient;
  jellyfin: JellyfinClient;
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

    const tools = createAgentTools({
      userId: input.userId,
      notificationTarget,
      tasks: this.deps.tasks,
      tmdb: this.deps.tmdb,
      jackett: this.deps.jackett,
      openList: this.deps.openList,
      jellyfin: this.deps.jellyfin,
      storageAuth:
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
                      type: "text",
                      text: "请使用 115 客户端扫描下方二维码。登录信息将由 OpenList 自动更新。",
                    },
                    {
                      type: "image",
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
          : undefined,
    });
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
          { role: "system", content: AGENT_SYSTEM_PROMPT },
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
      for (const call of result.toolCalls) {
        const tool = tools.find((candidate) => candidate.definition.name === call.name);
        let content: string;
        if (!tool) {
          content = JSON.stringify({ error: `Unknown tool: ${call.name}` });
        } else {
          try {
            const output = await tool.execute(call.arguments);
            content = JSON.stringify(output);
          } catch (error) {
            content = JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        this.deps.conversations.append(conversationId, {
          role: "tool",
          content: truncate(content, 24_000),
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
}

function truncate(value: string, length: number): string {
  return value.length > length
    ? `${value.slice(0, length)}…[truncated]`
    : value;
}
