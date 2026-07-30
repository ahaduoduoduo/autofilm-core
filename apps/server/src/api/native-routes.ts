import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  NativeEventResponse,
  NativeInboundEvent,
} from "@autofilm/contracts";
import { z } from "zod";
import type { AppContext } from "../app-context.js";
import { hashToken } from "../security/tokens.js";
import { agentMessages } from "../channels/agent-messages.js";

const eventSchema = z.object({
  version: z.string().min(1).max(30),
  event_id: z.string().min(1).max(300),
  event_type: z.enum(["message.created", "conversation.reset"]),
  provider: z.string().min(1).max(100),
  provider_instance_id: z.string().min(1).max(200),
  conversation_id: z.string().min(1).max(300),
  sender_id: z.string().min(1).max(300),
  message_id: z.string().max(300),
  message_type: z.string().max(100),
  text: z.string().optional(),
  attachments: z
    .array(
      z.object({
        type: z.enum(["image", "video", "audio", "file"]),
        file_name: z.string().optional(),
        content_type: z.string().optional(),
        url: z.string().optional(),
        data_base64: z.string().optional(),
      }),
    )
    .optional(),
  timestamp: z.string(),
  capabilities: z.array(z.string()).optional(),
});

export async function registerNativeRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  app.post("/v1/conversation/events", async (request, reply) => {
    const parsed = eventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid native event" });
    }
    const event = parsed.data as NativeInboundEvent;
    const channel = context.configs.channelByInstance(
      "native",
      event.provider_instance_id,
    );
    if (!channel || !channel.enabled) {
      return reply.code(404).send({ error: "Native channel is not configured" });
    }
    if (!authorized(request, channel.inboundTokenHash)) {
      return reply.code(401).send({ error: "Invalid service token" });
    }

    const cached = context.conversations.processedEvent(event.event_id);
    if (cached) return JSON.parse(cached) as NativeEventResponse;

    const identity = context.users.ensurePendingIdentity({
      channel: event.provider,
      providerInstanceId: event.provider_instance_id,
      externalUserId: event.sender_id,
      displayName: event.sender_id,
    });
    let response: NativeEventResponse;
    if (identity.status !== "active" || !identity.userId) {
      response = {
        messages: [
          {
            type: "text",
            text: "此账号尚未获得 AutoFilm 使用权限。管理员可在成员页面完成绑定。",
          },
        ],
      };
    } else if (event.event_type === "conversation.reset") {
      await context.agent.reset({
        userId: identity.userId,
        channel: event.provider,
        providerInstanceId: event.provider_instance_id,
        externalConversationId: event.conversation_id,
      });
      response = {
        messages: [{ type: "text", text: "当前会话记录已清除。" }],
      };
    } else {
      const text = eventText(event);
      if (!text) {
        response = {
          messages: [
            {
              type: "text",
              text: "当前只处理文本请求；附件信息已收到，但尚未启用多模态分析。",
            },
          ],
        };
      } else {
        try {
          const content = await context.agent.respond({
            userId: identity.userId,
            channel: event.provider,
            providerInstanceId: event.provider_instance_id,
            externalConversationId: event.conversation_id,
            text,
          });
          response = {
            messages: agentMessages(content, context.config.mediaBaseUrl),
          };
        } catch (error) {
          request.log.error({ err: error }, "native agent request failed");
          response = {
            messages: [
              {
                type: "text",
                text: `请求处理失败：${error instanceof Error ? error.message : "未知错误"}`,
              },
            ],
          };
        }
      }
    }
    context.conversations.saveProcessedEvent(
      event.event_id,
      JSON.stringify(response),
    );
    return response;
  });
}

function authorized(request: FastifyRequest, expectedHash: string): boolean {
  if (!expectedHash) return false;
  const raw = request.headers.authorization ?? "";
  const token = raw.toLowerCase().startsWith("bearer ")
    ? raw.slice(7).trim()
    : raw.trim();
  const actual = Buffer.from(hashToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function eventText(event: NativeInboundEvent): string {
  const parts: string[] = [];
  if (event.text?.trim()) parts.push(event.text.trim());
  for (const attachment of event.attachments ?? []) {
    parts.push(
      `[附件: ${attachment.type}${attachment.file_name ? ` ${attachment.file_name}` : ""}]`,
    );
  }
  return parts.join("\n");
}
