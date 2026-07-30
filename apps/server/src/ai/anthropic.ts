import { randomUUID } from "node:crypto";
import { postJson } from "./http.js";
import type {
  AiClient,
  AiTransportConfig,
  GenerateRequest,
  GenerateResponse,
  ToolCall,
} from "./types.js";

interface AnthropicPayload {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export class AnthropicMessagesClient implements AiClient {
  constructor(private readonly config: AiTransportConfig) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages: Array<{
      role: "user" | "assistant";
      content: Array<Record<string, unknown>>;
    }> = [];
    for (const message of request.messages) {
      if (message.role === "system") continue;
      if (message.role === "tool") {
        const part = {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        };
        const previous = messages.at(-1);
        if (previous?.role === "user" && isToolResult(previous.content.at(-1))) {
          previous.content.push(part);
        } else {
          messages.push({ role: "user", content: [part] });
        }
        continue;
      }
      const content: Array<Record<string, unknown>> = [
        { type: "text", text: message.content || " " },
        ...(message.images ?? []).map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.dataBase64,
          },
        })),
      ];
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      messages.push({ role: message.role, content });
    }
    const payload = await postJson<AnthropicPayload>(
      this.config,
      "messages",
      {
        model: request.model,
        system: system || undefined,
        messages,
        max_tokens: request.maxOutputTokens ?? 4096,
        temperature: request.temperature ?? undefined,
        tools: request.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      },
      {
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
    );
    const toolCalls: ToolCall[] = [];
    const text: string[] = [];
    for (const item of payload.content ?? []) {
      if (item.type === "text" && item.text) text.push(item.text);
      if (item.type === "tool_use" && item.name) {
        toolCalls.push({
          id: item.id ?? randomUUID(),
          name: item.name,
          arguments: item.input ?? {},
        });
      }
    }
    return {
      content: text.join("\n"),
      toolCalls,
      usage: {
        inputTokens: payload.usage?.input_tokens ?? 0,
        outputTokens: payload.usage?.output_tokens ?? 0,
      },
      rawStopReason: payload.stop_reason,
    };
  }
}

function isToolResult(value: Record<string, unknown> | undefined): boolean {
  return value?.type === "tool_result";
}
