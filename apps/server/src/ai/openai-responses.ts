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

interface ResponsesPayload {
  output?: Array<{
    type: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string | Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
  }>;
  output_text?: string;
  status?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export class OpenAiResponsesClient implements AiClient {
  constructor(private readonly config: AiTransportConfig) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const instructions = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const input = request.messages
      .filter((message) => message.role !== "system")
      .flatMap(toResponsesInput);
    const payload = await postJson<ResponsesPayload>(
      this.config,
      "responses",
      {
        model: request.model,
        instructions: instructions || undefined,
        input,
        tools: request.tools?.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        })),
        temperature: request.temperature ?? undefined,
        max_output_tokens: request.maxOutputTokens ?? undefined,
      },
      bearerHeaders(this.config.apiKey),
    );

    const toolCalls: ToolCall[] = [];
    const textParts: string[] = [];
    for (const item of payload.output ?? []) {
      if (item.type === "function_call" && item.name) {
        toolCalls.push({
          id: item.call_id ?? item.id ?? randomUUID(),
          name: item.name,
          arguments: parseArguments(item.arguments),
        });
      }
      if (item.type === "message") {
        for (const content of item.content ?? []) {
          if (content.type === "output_text" && content.text) {
            textParts.push(content.text);
          }
        }
      }
    }
    return {
      content: payload.output_text ?? textParts.join("\n"),
      toolCalls,
      usage: {
        inputTokens: payload.usage?.input_tokens ?? 0,
        outputTokens: payload.usage?.output_tokens ?? 0,
      },
      rawStopReason: payload.status,
    };
  }
}

function toResponsesInput(message: CanonicalMessage): unknown[] {
  if (message.role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      },
    ];
  }
  const items: unknown[] = [
    {
      role: message.role,
      content: message.content,
    },
  ];
  if (message.role === "assistant") {
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      });
    }
  }
  return items;
}

function parseArguments(
  value: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}
