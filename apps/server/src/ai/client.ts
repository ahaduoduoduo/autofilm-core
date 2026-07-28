import type { AiProtocol } from "@autofilm/contracts";
import { AnthropicMessagesClient } from "./anthropic.js";
import { GeminiGenerateContentClient } from "./gemini.js";
import { OpenAiChatClient } from "./openai-chat.js";
import { OpenAiResponsesClient } from "./openai-responses.js";
import type { AiClient, AiTransportConfig } from "./types.js";

export function createAiClient(
  protocol: AiProtocol,
  config: AiTransportConfig,
): AiClient {
  switch (protocol) {
    case "openai-responses":
      return new OpenAiResponsesClient(config);
    case "openai-chat-completions":
      return new OpenAiChatClient(config);
    case "anthropic-messages":
      return new AnthropicMessagesClient(config);
    case "gemini-generate-content":
      return new GeminiGenerateContentClient(config);
  }
}
