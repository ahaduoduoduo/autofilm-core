import type { AiProtocol } from "@autofilm/contracts";
import { AnthropicMessagesClient } from "./anthropic.js";
import { GeminiGenerateContentClient } from "./gemini.js";
import { OpenAiChatClient } from "./openai-chat.js";
import { OpenAiResponsesClient } from "./openai-responses.js";
import { recoverToolHistory } from "./history.js";
import type {
  AiClient,
  AiTransportConfig,
  GenerateRequest,
  GenerateResponse,
} from "./types.js";

export function createAiClient(
  protocol: AiProtocol,
  config: AiTransportConfig,
): AiClient {
  let client: AiClient;
  switch (protocol) {
    case "openai-responses":
      client = new OpenAiResponsesClient(config);
      break;
    case "openai-chat-completions":
      client = new OpenAiChatClient(config);
      break;
    case "anthropic-messages":
      client = new AnthropicMessagesClient(config);
      break;
    case "gemini-generate-content":
      client = new GeminiGenerateContentClient(config);
      break;
  }
  return withRecoverableHistory(client);
}

export function withRecoverableHistory(client: AiClient): AiClient {
  return new RecoverableHistoryClient(client);
}

class RecoverableHistoryClient implements AiClient {
  constructor(private readonly client: AiClient) {}

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const recovered = recoverToolHistory(request.messages);
    try {
      return await this.client.generate({
        ...request,
        messages: recovered,
      });
    } catch (error) {
      if (!isToolHistoryError(error)) throw error;
      return this.client.generate({
        ...request,
        messages: latestUserTurn(recovered),
      });
    }
  }
}

function latestUserTurn(
  messages: GenerateRequest["messages"],
): GenerateRequest["messages"] {
  const system = messages.filter((message) => message.role === "system");
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  return lastUserIndex < 0
    ? messages
    : [...system, ...messages.slice(lastUserIndex)];
}

function isToolHistoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No tool call found for function call output") ||
    message.includes("No tool output found for function call")
  );
}
