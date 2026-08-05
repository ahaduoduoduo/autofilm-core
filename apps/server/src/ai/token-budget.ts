import type { ModelProfile } from "@autofilm/contracts";
import type {
  CanonicalMessage,
  ToolDefinition,
} from "./types.js";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export const DEFAULT_TOOL_OUTPUT_TOKENS = 12_000;
const DEFAULT_AUTO_COMPACT_RATIO = 0.8;
const MAX_AUTO_COMPACT_RATIO = 0.9;

export interface ContextBudgetPolicy {
  contextWindowTokens: number;
  autoCompactTokenLimit: number;
  toolOutputTokenLimit: number;
}

export function contextBudgetPolicy(
  model: Pick<
    ModelProfile,
    | "contextWindowTokens"
    | "autoCompactTokenLimit"
    | "toolOutputTokenLimit"
  >,
): ContextBudgetPolicy {
  const contextWindowTokens = positiveInteger(
    model.contextWindowTokens,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
  );
  const maximumAutoCompact = Math.max(
    1,
    Math.floor(contextWindowTokens * MAX_AUTO_COMPACT_RATIO),
  );
  const configuredAutoCompact = model.autoCompactTokenLimit ??
    Math.floor(contextWindowTokens * DEFAULT_AUTO_COMPACT_RATIO);
  return {
    contextWindowTokens,
    autoCompactTokenLimit: Math.min(
      positiveInteger(configuredAutoCompact, maximumAutoCompact),
      maximumAutoCompact,
    ),
    toolOutputTokenLimit: positiveInteger(
      model.toolOutputTokenLimit,
      DEFAULT_TOOL_OUTPUT_TOKENS,
    ),
  };
}

export function estimateGenerateRequestTokens(
  messages: CanonicalMessage[],
  tools: ToolDefinition[] = [],
): number {
  const messageTokens = messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
  const toolTokens = tools.length === 0
    ? 0
    : estimateTextTokens(JSON.stringify(tools)) + tools.length * 12;
  return messageTokens + toolTokens;
}

export function estimateMessageTokens(message: CanonicalMessage): number {
  const calls = message.toolCalls?.length
    ? estimateTextTokens(JSON.stringify(message.toolCalls))
    : 0;
  const images = (message.images ?? []).reduce(
    (total, image) => total + Math.ceil(image.dataBase64.length / 4),
    0,
  );
  return 8 + estimateTextTokens(message.content) + calls + images;
}

/**
 * A deliberately conservative cross-provider estimate. ASCII-heavy text is
 * counted at roughly three characters per token; CJK and other non-ASCII code
 * points count as one token each. Provider usage remains authoritative after a
 * request, while this estimate protects the request before it is sent.
 */
export function estimateTextTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 3) + nonAscii;
}

export function truncateTextToTokenBudget(
  value: string,
  tokenLimit: number,
): string {
  const limit = Math.max(0, Math.floor(tokenLimit));
  if (estimateTextTokens(value) <= limit) return value;
  if (limit === 0) return "";

  const marker = "\n…[中间内容因上下文预算省略]…\n";
  const markerTokens = estimateTextTokens(marker);
  if (limit <= markerTokens + 2) {
    return takeFromStart(value, limit);
  }
  const available = limit - markerTokens;
  const startBudget = Math.ceil(available * 0.7);
  const endBudget = available - startBudget;
  return `${takeFromStart(value, startBudget)}${marker}${takeFromEnd(
    value,
    endBudget,
  )}`;
}

export function limitToolOutputs(
  messages: CanonicalMessage[],
  tokenLimit: number,
): CanonicalMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    const estimated = estimateTextTokens(message.content);
    if (estimated <= tokenLimit) return message;
    const notice =
      `[工具结果已限制；原始估算 ${estimated.toLocaleString()} tokens，` +
      `当前预算 ${tokenLimit.toLocaleString()} tokens]\n`;
    return {
      ...message,
      content:
        notice +
        truncateTextToTokenBudget(
          message.content,
          Math.max(0, tokenLimit - estimateTextTokens(notice)),
        ),
    };
  });
}

function takeFromStart(value: string, tokenLimit: number): string {
  let ascii = 0;
  let nonAscii = 0;
  let result = "";
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
    if (Math.ceil(ascii / 3) + nonAscii > tokenLimit) break;
    result += character;
  }
  return result;
}

function takeFromEnd(value: string, tokenLimit: number): string {
  const characters = [...value];
  let ascii = 0;
  let nonAscii = 0;
  const selected: string[] = [];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
    if (Math.ceil(ascii / 3) + nonAscii > tokenLimit) break;
    selected.push(character);
  }
  return selected.reverse().join("");
}

function positiveInteger(value: number | null | undefined, fallback: number) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
