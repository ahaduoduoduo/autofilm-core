import { createHash } from "node:crypto";
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
const MAX_CHUNK_SUMMARY_OUTPUT_TOKENS = 4_000;
const COMPACTION_CHUNK_CONCURRENCY = 3;
const COMPACTION_CHUNK_VERSION = 1;

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

    const prompt = this.prompts.get("conversation.compactor");
    const summary = chunks.length === 1
      ? await this.compactSingleChunk(input, prompt, plan, chunks[0]!)
      : await this.compactMultipleChunks(input, prompt, plan, chunks);

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

  private async compactSingleChunk(
    input: {
      client: AiClient;
      model: ModelProfile;
      policy: ContextBudgetPolicy;
    },
    prompt: string,
    plan: {
      previousSummary: string;
      splitTurn: boolean;
    },
    chunk: string,
  ): Promise<string> {
    const result = await input.client.generate({
      model: input.model.model,
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content:
            `此前压缩检查点：\n${plan.previousSummary.trim() || "无"}\n\n` +
            `新增的较早会话前缀：\n${chunk}${splitTurnNotice(plan.splitTurn)}`,
        },
      ],
      temperature: 0,
      maxOutputTokens: compactionOutputTokens(input.model, input.policy),
    });
    return requiredSummary(result.content);
  }

  private async compactMultipleChunks(
    input: {
      conversationId: string;
      client: AiClient;
      model: ModelProfile;
      policy: ContextBudgetPolicy;
    },
    prompt: string,
    plan: {
      previousSummary: string;
      splitTurn: boolean;
    },
    chunks: string[],
  ): Promise<string> {
    const summaries = await mapConcurrentRecoverable(
      chunks,
      COMPACTION_CHUNK_CONCURRENCY,
      async (chunk, index) => {
        const isSplitTail = plan.splitTurn && index === chunks.length - 1;
        const sourceHash = compactionChunkHash({
          prompt,
          model: input.model.model,
          chunk,
          isSplitTail,
        });
        const cached = this.conversations.compactionChunk(
          input.conversationId,
          sourceHash,
        );
        if (cached) return cached;

        const result = await input.client.generate({
          model: input.model.model,
          messages: [
            {
              role: "system",
              content:
                `${prompt}\n\n` +
                "当前调用只生成一个临时分块草稿。不要引用其他分块，也不要把草稿" +
                "描述为最终检查点；仍按上述结构提炼当前材料。",
            },
            {
              role: "user",
              content:
                `较早会话前缀的一个独立分块：\n${chunk}` +
                splitTurnNotice(isSplitTail),
            },
          ],
          temperature: 0,
          maxOutputTokens: Math.min(
            MAX_CHUNK_SUMMARY_OUTPUT_TOKENS,
            compactionOutputTokens(input.model, input.policy),
          ),
        });
        const summary = requiredSummary(result.content);
        this.conversations.saveCompactionChunk({
          conversationId: input.conversationId,
          sourceHash,
          summary,
          sourceTokenEstimate: estimateTextTokens(chunk),
          summaryTokenEstimate: estimateTextTokens(summary),
        });
        return summary;
      },
    );

    const result = await input.client.generate({
      model: input.model.model,
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content:
            `此前压缩检查点：\n${plan.previousSummary.trim() || "无"}\n\n` +
            "以下是较早会话前缀按时间顺序生成的临时分块草稿。把它们与此前检查点" +
            "合并为一个唯一、完整的新检查点；不得保留分块层级或逐块复述。\n\n" +
            summaries
              .map(
                (summary, index) =>
                  `--- 分块 ${index + 1}/${summaries.length} ---\n${summary}`,
              )
              .join("\n\n") +
            splitTurnNotice(plan.splitTurn),
        },
      ],
      temperature: 0,
      maxOutputTokens: compactionOutputTokens(input.model, input.policy),
    });
    return requiredSummary(result.content);
  }
}

function splitTurnNotice(enabled: boolean): string {
  return enabled
    ? "\n\n注意：近期原始消息从一次尚未完整结束的交互中间开始，" +
        "检查点必须保留该交互前半段的目标、工具调用原因和必要标识。"
    : "";
}

function requiredSummary(content: string): string {
  const summary = content.trim();
  if (!summary) throw new Error("会话压缩模型没有返回检查点");
  return summary;
}

function compactionChunkHash(input: {
  prompt: string;
  model: string;
  chunk: string;
  isSplitTail: boolean;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: COMPACTION_CHUNK_VERSION,
        prompt: input.prompt,
        model: input.model,
        chunk: input.chunk,
        isSplitTail: input.isSplitTail,
      }),
    )
    .digest("hex");
}

async function mapConcurrentRecoverable<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  let failure: unknown;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (!failed) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        try {
          results[index] = await operation(items[index]!, index);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
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
