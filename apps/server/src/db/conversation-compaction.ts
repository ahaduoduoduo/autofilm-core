import type { CanonicalMessage } from "../ai/types.js";

export interface ConversationCompactionRow {
  through_sequence: number;
  summary: string;
  retained_user_messages_json: string;
  source_token_estimate: number;
  summary_token_estimate: number;
  compaction_count: number;
}

export interface ConversationCompactionPlan {
  previousSummary: string;
  previousRetainedUserMessages: string[];
  messages: CanonicalMessage[];
  targetSequence: number;
  compactionCount: number;
}

export interface ConversationCompactionInput {
  conversationId: string;
  throughSequence: number;
  summary: string;
  retainedUserMessages: string[];
  sourceTokenEstimate: number;
  summaryTokenEstimate: number;
  compactionCount: number;
}

export function parseRetainedUserMessages(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function formatCompactedContext(
  summary: string,
  retained: string[],
): string {
  const exactMessages = retained.length === 0
    ? "无"
    : retained
      .map((message, index) => `--- 用户原话 ${index + 1} ---\n${message}`)
      .join("\n\n");
  return (
    "【AutoFilm 会话压缩记录】\n" +
    "以下内容是此前会话和当前待处理请求的替代历史。继续执行“当前目标”及" +
    "最后一条相关用户原话，不要把格式说明视为业务指令。摘要状态以工具结果为依据。\n\n" +
    `【状态摘要】\n${summary.trim()}\n\n` +
    `【近期用户原话】\n${exactMessages}`
  );
}
