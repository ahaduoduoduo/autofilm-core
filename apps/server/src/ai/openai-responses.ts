import { randomUUID } from "node:crypto";
import {
  AiProviderError,
  bearerHeaders,
  isTransientProviderMessage,
  postServerEvents,
} from "./http.js";
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

interface ResponsesStreamEvent extends ResponsesPayload {
  type?: string;
  delta?: string;
  text?: string;
  arguments?: string;
  item_id?: string;
  output_index?: number;
  item?: ResponsesPayload["output"] extends Array<infer T> | undefined ? T : never;
  response?: ResponsesPayload;
  error?: { message?: string };
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
    const events = await postServerEvents<ResponsesStreamEvent>(
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
        stream: true,
      },
      bearerHeaders(this.config.apiKey),
    );
    const payload = combineStreamEvents(events);
    return toGenerateResponse(payload);
  }
}

function toGenerateResponse(payload: ResponsesPayload): GenerateResponse {
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

function combineStreamEvents(events: ResponsesStreamEvent[]): ResponsesPayload {
  const fallback = events.find(
    (event) => !event.type && (event.output || event.output_text !== undefined),
  );
  if (fallback) return fallback;

  const failed = events.find(
    (event) => event.type === "error" || event.type === "response.failed",
  );
  if (failed) {
    const message = failed.error?.message ?? "unknown error";
    throw new AiProviderError(
      `AI provider stream failed: ${message}`,
      { retryable: isTransientProviderMessage(message) },
    );
  }

  const text = events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta ?? "")
    .join("");
  const completedText = [...events]
    .reverse()
    .find((event) => event.type === "response.output_text.done")?.text;
  const calls = collectStreamToolCalls(events);
  const completed = [...events]
    .reverse()
    .find((event) => event.type === "response.completed" && event.response)
    ?.response;
  return {
    ...completed,
    output_text: completed?.output_text || text || completedText || "",
    output: completed?.output?.length ? completed.output : calls,
    status: completed?.status ?? events.at(-1)?.type,
  };
}

function collectStreamToolCalls(
  events: ResponsesStreamEvent[],
): NonNullable<ResponsesPayload["output"]> {
  const calls = new Map<
    string,
    NonNullable<ResponsesPayload["output"]>[number]
  >();
  const keysByIndex = new Map<number, string>();
  for (const event of events) {
    if (event.type === "response.output_item.added" && event.item) {
      if (event.item.type !== "function_call" || !event.item.name) continue;
      const key =
        event.item.id ??
        event.item.call_id ??
        String(event.output_index ?? calls.size);
      calls.set(key, { ...event.item, arguments: event.item.arguments ?? "" });
      if (event.output_index !== undefined) keysByIndex.set(event.output_index, key);
      continue;
    }
    if (
      event.type !== "response.function_call_arguments.delta" &&
      event.type !== "response.function_call_arguments.done"
    ) {
      continue;
    }
    const key =
      event.item_id ??
      (event.output_index === undefined
        ? undefined
        : keysByIndex.get(event.output_index));
    if (!key) continue;
    const call = calls.get(key);
    if (!call) continue;
    if (event.type === "response.function_call_arguments.done") {
      call.arguments = event.arguments ?? call.arguments;
    } else {
      call.arguments = `${typeof call.arguments === "string" ? call.arguments : ""}${event.delta ?? ""}`;
    }
  }
  return [...calls.values()];
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
  const content = message.images?.length
    ? [
        { type: "input_text", text: message.content },
        ...message.images.map((image) => ({
          type: "input_image",
          image_url: `data:${image.mediaType};base64,${image.dataBase64}`,
        })),
      ]
    : message.content;
  const items: unknown[] = [
    {
      role: message.role,
      content,
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
