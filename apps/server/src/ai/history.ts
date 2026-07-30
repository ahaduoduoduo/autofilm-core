import type { CanonicalMessage, ToolCall } from "./types.js";

const INTERRUPTED_TOOL_RESULT = JSON.stringify({
  error:
    "The previous tool result was not persisted. Inspect current service state before retrying any operation with side effects.",
  recoverable: true,
});

export function recoverToolHistory(
  messages: CanonicalMessage[],
): CanonicalMessage[] {
  const recovered: CanonicalMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "tool") {
      continue;
    }
    const calls = validToolCalls(message);
    if (message.role !== "assistant" || calls.length === 0) {
      recovered.push(withoutToolMetadata(message));
      continue;
    }

    recovered.push({
      ...withoutToolMetadata(message),
      role: "assistant",
      toolCalls: calls,
    });
    const available = new Map<string, CanonicalMessage>();
    let outputIndex = index + 1;
    while (
      outputIndex < messages.length &&
      messages[outputIndex]!.role === "tool"
    ) {
      const output = messages[outputIndex]!;
      if (output.toolCallId && !available.has(output.toolCallId)) {
        available.set(output.toolCallId, output);
      }
      outputIndex += 1;
    }
    for (const call of calls) {
      recovered.push(toolResult(call, available.get(call.id)));
    }
    index = outputIndex - 1;
  }
  return recovered;
}

function toolResult(
  call: ToolCall,
  output: CanonicalMessage | undefined,
): CanonicalMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    content: output?.content ?? INTERRUPTED_TOOL_RESULT,
  };
}

function withoutToolMetadata(message: CanonicalMessage): CanonicalMessage {
  const { toolCalls: _toolCalls, toolCallId: _toolCallId, ...content } =
    message;
  return content;
}

function validToolCalls(message: CanonicalMessage): ToolCall[] {
  const seen = new Set<string>();
  return (message.toolCalls ?? []).filter((call) => {
    if (!call.id || !call.name || seen.has(call.id)) return false;
    seen.add(call.id);
    return true;
  });
}
