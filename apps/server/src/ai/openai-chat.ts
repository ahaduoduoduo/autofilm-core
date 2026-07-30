import { randomUUID } from "node:crypto";
import { bearerHeaders, postJson } from "./http.js";
import type {
  AiClient,
  AiTransportConfig,
  CanonicalMessage,
  GenerateRequest,
  GenerateResponse,
  ToolCall,
} from "./types.js";

interface ChatPayload {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export class OpenAiChatClient implements AiClient {
  constructor(private readonly config: AiTransportConfig) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const payload = await postJson<ChatPayload>(
      this.config,
      "chat/completions",
      {
        model: request.model,
        messages: request.messages.map(toChatMessage),
        tools: request.tools?.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        temperature: request.temperature ?? undefined,
        max_tokens: request.maxOutputTokens ?? undefined,
      },
      bearerHeaders(this.config.apiKey),
    );
    const choice = payload.choices?.[0];
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map(
      (call) => ({
        id: call.id ?? randomUUID(),
        name: call.function?.name ?? "unknown_tool",
        arguments: parseArguments(call.function?.arguments),
      }),
    );
    return {
      content: choice?.message?.content ?? "",
      toolCalls,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
      rawStopReason: choice?.finish_reason,
    };
  }
}

function toChatMessage(message: CanonicalMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  return {
    role: message.role,
    content: message.images?.length
      ? [
          { type: "text", text: message.content },
          ...message.images.map((image) => ({
            type: "image_url",
            image_url: {
              url: `data:${image.mediaType};base64,${image.dataBase64}`,
            },
          })),
        ]
      : message.content,
    tool_calls: message.toolCalls?.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      },
    })),
  };
}

function parseArguments(value: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(value ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
