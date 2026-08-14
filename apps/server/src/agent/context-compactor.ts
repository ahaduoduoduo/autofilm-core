import type { ModelProfile } from "@autofilm/contracts";
import type { AiClient } from "../ai/types.js";
import {
  type ContextBudgetPolicy,
  estimateMessageTokens,
  estimateTextTokens,
} from "../ai/token-budget.js";
import type { ConversationStore } from "../db/conversation-store.js";
import type { PromptStore } from "../db/prompt-store.js";
import { recoverToolHistory } from "../ai/history.js";
import { splitConversationTranscript } from "./conversation-transcript.js";

const MAX_COMPACTION_CHUNK_TOKENS = 48_000;
const MAX_COMPACTION_OUTPUT_TOKENS = 8_000;

export interface CompactionResult {
  compacted: boolean;
  throughSequence?: number;
  sourceTokenEstimate?: number;
  summaryTokenEstimate?: number;
  compactionCount?: number;
}

export class LocalContextCompactor {
  constructor(
    private readonly conversations: ConversationStore,
    private readonly prompts: PromptStore,
  ) {}

  async compact(input: {
    conversationId: string;
    client: AiClient;
    model: ModelProfile;
    policy: ContextBudgetPolicy;
  }): Promise<CompactionResult> {
    const plan = this.conversations.compactionPlan(input.conversationId, {
      keepRecentTokens: input.policy.compactKeepRecentTokens,
      toolOutputTokenLimit: input.policy.toolOutputTokenLimit,
    });
    if (!plan) return { compacted: false };

    const messages = recoverToolHistory(plan.messages);
    const chunkTokenLimit = Math.max(
      4_000,
      Math.min(
        MAX_COMPACTION_CHUNK_TOKENS,
        Math.floor(input.policy.contextWindowTokens * 0.5),
      ),
    );
    const chunks = splitConversationTranscript(messages, chunkTokenLimit);
    if (chunks.length === 0) return { compacted: false };

    let summary = plan.previousSummary;
    for (const [index, chunk] of chunks.entries()) {
      const result = await input.client.generate({
        model: input.model.model,
        messages: [
          {
            role: "system",
            content: this.prompts.get("conversation.compactor"),
          },
          {
            role: "user",
            content:
              `此前压缩检查点：\n${summary.trim() || "无"}\n\n` +
              `新增的较早会话前缀 ${index + 1}/${chunks.length}：\n${chunk}` +
              (plan.splitTurn
                ? "\n\n注意：近期原始消息从一次尚未完整结束的交互中间开始，" +
                  "检查点必须保留该交互前半段的目标、工具调用原因和必要标识。"
                : ""),
          },
        ],
        temperature: 0,
        maxOutputTokens: compactionOutputTokens(input.model, input.policy),
      });
      summary = result.content.trim();
      if (!summary) throw new Error("会话压缩模型没有返回检查点");
    }

    const sourceTokenEstimate =
      estimateTextTokens(plan.previousSummary) +
      messages.reduce(
        (total, message) => total + estimateMessageTokens(message),
        0,
      );
    const summaryTokenEstimate = estimateTextTokens(summary);
    this.conversations.saveCompaction({
      conversationId: input.conversationId,
      throughSequence: plan.targetSequence,
      summary,
      sourceTokenEstimate,
      summaryTokenEstimate,
      compactionCount: plan.compactionCount,
    });
    return {
      compacted: true,
      throughSequence: plan.targetSequence,
      sourceTokenEstimate,
      summaryTokenEstimate,
      compactionCount: plan.compactionCount,
    };
  }
}

function compactionOutputTokens(
  model: ModelProfile,
  policy: ContextBudgetPolicy,
): number {
  return Math.min(
    model.maxOutputTokens ?? MAX_COMPACTION_OUTPUT_TOKENS,
    MAX_COMPACTION_OUTPUT_TOKENS,
    Math.max(1_000, Math.floor(policy.compactionReserveTokens * 0.75)),
  );
}
