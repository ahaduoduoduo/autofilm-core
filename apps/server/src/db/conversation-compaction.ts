import type { CanonicalMessage } from "../ai/types.js";

export interface ConversationCompactionRow {
  through_sequence: number;
  summary: string;
  source_token_estimate: number;
  summary_token_estimate: number;
  compaction_count: number;
}

export interface ConversationCompactionPlan {
  previousSummary: string;
  messages: CanonicalMessage[];
  targetSequence: number;
  compactionCount: number;
  splitTurn: boolean;
}

export interface ConversationCompactionInput {
  conversationId: string;
  throughSequence: number;
  summary: string;
  sourceTokenEstimate: number;
  summaryTokenEstimate: number;
  compactionCount: number;
}

export function formatCompactedContext(summary: string): string {
  return (
    "【AutoFilm 会话压缩检查点】\n" +
    "以下内容替代较早的会话前缀。检查点之后的消息是未经摘要的近期原始历史；" +
    "继续任务时同时使用检查点和近期历史，业务状态仍以工具查询结果为准。\n\n" +
    summary.trim()
  );
}
