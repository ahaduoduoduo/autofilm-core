import type { ModelProfile } from "@autofilm/contracts";
import type { AiClient, CanonicalMessage } from "../ai/types.js";
import {
  type ContextBudgetPolicy,
  estimateMessageTokens,
  estimateTextTokens,
  truncateTextToTokenBudget,
} from "../ai/token-budget.js";
import type { ConversationStore } from "../db/conversation-store.js";
import type { PromptStore } from "../db/prompt-store.js";
import { recoverToolHistory } from "../ai/history.js";
import { splitConversationTranscript } from "./conversation-transcript.js";

const MAX_RETAINED_USER_MESSAGE_TOKENS = 20_000;
const MAX_COMPACTION_CHUNK_TOKENS = 48_000;
const MAX_COMPACTION_OUTPUT_TOKENS = 4_000;

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
    const plan = this.conversations.compactionPlan(input.conversationId);
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
              `此前压缩摘要：\n${summary.trim() || "无"}\n\n` +
              `新增会话片段 ${index + 1}/${chunks.length}：\n${chunk}`,
          },
        ],
        temperature: 0,
        maxOutputTokens: Math.min(
          input.model.maxOutputTokens ?? MAX_COMPACTION_OUTPUT_TOKENS,
          MAX_COMPACTION_OUTPUT_TOKENS,
        ),
      });
      summary = result.content.trim();
      if (!summary) throw new Error("会话本地压缩模型没有返回摘要");
    }

    const retainedUserMessages = selectRetainedUserMessages(
      [
        ...plan.previousRetainedUserMessages,
        ...messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ],
      Math.min(
        MAX_RETAINED_USER_MESSAGE_TOKENS,
        Math.max(1_000, Math.floor(input.policy.contextWindowTokens * 0.15)),
      ),
    );
    const sourceTokenEstimate =
      estimateTextTokens(plan.previousSummary) +
      messages.reduce(
        (total, message) => total + estimateMessageTokens(message),
        0,
      );
    const summaryTokenEstimate =
      estimateTextTokens(summary) +
      retainedUserMessages.reduce(
        (total, message) => total + estimateTextTokens(message),
        0,
      );
    this.conversations.saveCompaction({
      conversationId: input.conversationId,
      throughSequence: plan.targetSequence,
      summary,
      retainedUserMessages,
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

function selectRetainedUserMessages(
  messages: string[],
  tokenLimit: number,
): string[] {
  const selected: string[] = [];
  let remaining = tokenLimit;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (remaining <= 0) break;
    const message = messages[index]!.trim();
    if (!message) continue;
    const tokens = estimateTextTokens(message);
    if (tokens <= remaining) {
      selected.unshift(message);
      remaining -= tokens;
      continue;
    }
    selected.unshift(truncateTextToTokenBudget(message, remaining));
    break;
  }
  return selected;
}
