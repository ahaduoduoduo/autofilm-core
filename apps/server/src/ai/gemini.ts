import { randomUUID } from "node:crypto";
import { postJson } from "./http.js";
import type {
  AiClient,
  AiTransportConfig,
  GenerateRequest,
  GenerateResponse,
  ToolCall,
} from "./types.js";

interface GeminiPayload {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: {
          id?: string;
          name?: string;
          args?: Record<string, unknown>;
        };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

export class GeminiGenerateContentClient implements AiClient {
  constructor(private readonly config: AiTransportConfig) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const systemText = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const contents: Array<{
      role: "user" | "model";
      parts: Array<Record<string, unknown>>;
    }> = [];
    for (const message of request.messages) {
      if (message.role === "system") continue;
      if (message.role === "tool") {
        const part = {
          functionResponse: {
            id: message.toolCallId,
            name: findToolName(request.messages, message.toolCallId),
            response: { output: message.content },
          },
        };
        const previous = contents.at(-1);
        if (previous?.role === "user" && isFunctionResponse(previous.parts.at(-1))) {
          previous.parts.push(part);
        } else {
          contents.push({ role: "user", parts: [part] });
        }
        continue;
      }
      const parts: Array<Record<string, unknown>> = [
        { text: message.content || " " },
      ];
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: {
            id: call.id,
            name: call.name,
            args: call.arguments,
          },
        });
      }
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts,
      });
    }
    const apiKeyQuery = this.config.apiKey
      ? `?key=${encodeURIComponent(this.config.apiKey)}`
      : "";
    const payload = await postJson<GeminiPayload>(
      this.config,
      `models/${encodeURIComponent(request.model)}:generateContent${apiKeyQuery}`,
      {
        systemInstruction: systemText
          ? { parts: [{ text: systemText }] }
          : undefined,
        contents,
        tools: request.tools?.length
          ? [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              },
            ]
          : undefined,
        generationConfig: {
          temperature: request.temperature ?? undefined,
          maxOutputTokens: request.maxOutputTokens ?? undefined,
        },
      },
    );
    const candidate = payload.candidates?.[0];
    const text: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text) text.push(part.text);
      if (part.functionCall?.name) {
        toolCalls.push({
          id: part.functionCall.id ?? randomUUID(),
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }
    return {
      content: text.join("\n"),
      toolCalls,
      usage: {
        inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      },
      rawStopReason: candidate?.finishReason,
    };
  }
}

function findToolName(
  messages: GenerateRequest["messages"],
  toolCallId: string | undefined,
): string {
  for (const message of messages) {
    const match = message.toolCalls?.find((call) => call.id === toolCallId);
    if (match) return match.name;
  }
  return "unknown_tool";
}

function isFunctionResponse(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value?.functionResponse);
}
