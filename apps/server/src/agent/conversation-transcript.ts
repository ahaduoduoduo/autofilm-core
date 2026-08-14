import type { CanonicalMessage } from "../ai/types.js";
import {
  estimateTextTokens,
  truncateTextToTokenBudget,
} from "../ai/token-budget.js";

export function splitConversationTranscript(
  messages: CanonicalMessage[],
  maximumChunkTokens: number,
): string[] {
  const limit = Math.max(1_000, maximumChunkTokens);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const message of messages) {
    let block = formatMessageBlock(message);
    let tokens = estimateTextTokens(block);
    if (tokens > limit) {
      block = truncateTextToTokenBudget(block, limit);
      tokens = estimateTextTokens(block);
    }
    if (current.length > 0 && currentTokens + tokens > limit) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentTokens = 0;
    }
    current.push(block);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));
  return chunks;
}

function formatMessageBlock(message: CanonicalMessage): string {
  const calls = (message.toolCalls ?? [])
    .map(
      (call) =>
        `${call.name}(${truncateTextToTokenBudget(
          JSON.stringify(call.arguments),
          2_000,
        )})`,
    )
    .join(", ");
  const contentLimit = message.role === "tool" ? 6_000 : 12_000;
  return (
    `[${message.role}${message.toolCallId ? ` ${message.toolCallId}` : ""}]` +
    `${calls ? ` 工具：${calls}` : ""}\n` +
    truncateTextToTokenBudget(message.content, contentLimit)
  );
}
