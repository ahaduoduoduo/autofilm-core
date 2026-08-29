import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";
import type { CanonicalMessage, ToolCall } from "../ai/types.js";
import {
  estimateMessageTokens,
  limitToolOutputs,
} from "../ai/token-budget.js";
import {
  type ConversationCompactionInput,
  type ConversationCompactionPlan,
  type ConversationCompactionRow,
  formatCompactedContext,
} from "./conversation-compaction.js";

export type {
  ConversationCompactionInput,
  ConversationCompactionPlan,
} from "./conversation-compaction.js";

interface ConversationRow {
  id: string;
}

interface MessageRow {
  sequence: number;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls_json: string | null;
  tool_call_id: string | null;
}

export interface StoredMessage {
  id: string;
  sequence: number;
}

export class ConversationStore {
  constructor(private readonly db: AppDatabase) {}

  getOrCreate(input: {
    userId: string;
    channel: string;
    providerInstanceId: string;
    externalConversationId: string;
  }): string {
    const existing = this.db
      .prepare(
        `SELECT id FROM conversations
         WHERE user_id = ? AND channel = ? AND provider_instance_id = ?
           AND external_conversation_id = ?`,
      )
      .get(
        input.userId,
        input.channel,
        input.providerInstanceId,
        input.externalConversationId,
      ) as ConversationRow | undefined;
    if (existing) return existing.id;

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conversations
          (id, user_id, channel, provider_instance_id, external_conversation_id,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.channel,
        input.providerInstanceId,
        input.externalConversationId,
        now,
        now,
      );
    return id;
  }

  reset(input: {
    userId: string;
    channel: string;
    providerInstanceId: string;
    externalConversationId: string;
  }): void {
    const row = this.db
      .prepare(
        `SELECT id FROM conversations
         WHERE user_id = ? AND channel = ? AND provider_instance_id = ?
           AND external_conversation_id = ?`,
      )
      .get(
        input.userId,
        input.channel,
        input.providerInstanceId,
        input.externalConversationId,
      ) as ConversationRow | undefined;
    if (!row) return;

    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM conversation_compactions WHERE conversation_id = ?",
        )
        .run(row.id);
      this.db
        .prepare(
          "DELETE FROM conversation_compaction_chunks WHERE conversation_id = ?",
        )
        .run(row.id);
      this.db
        .prepare("DELETE FROM messages WHERE conversation_id = ?")
        .run(row.id);
    })();
  }

  append(conversationId: string, message: CanonicalMessage): StoredMessage {
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO messages
          (id, conversation_id, role, content, tool_calls_json, tool_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        conversationId,
        message.role,
        message.content,
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.toolCallId ?? null,
        now,
      );
    this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(now, conversationId);
    return { id, sequence: Number(result.lastInsertRowid) };
  }

  modelHistory(
    conversationId: string,
    options: { toolOutputTokenLimit?: number } = {},
  ): CanonicalMessage[] {
    const compaction = this.compactionRow(conversationId);
    const messages = compaction
      ? this.compactedModelHistory(conversationId, compaction)
      : this.fullHistory(conversationId);
    return options.toolOutputTokenLimit
      ? limitToolOutputs(messages, options.toolOutputTokenLimit)
      : messages;
  }

  compactionPlan(
    conversationId: string,
    options: {
      keepRecentTokens: number;
      toolOutputTokenLimit: number;
    },
  ): ConversationCompactionPlan | undefined {
    const previous = this.compactionRow(conversationId);
    const rows = this.db
      .prepare(
        `SELECT rowid AS sequence, role, content, tool_calls_json, tool_call_id
         FROM messages
         WHERE conversation_id = ? AND rowid > ?
         ORDER BY rowid`,
      )
      .all(conversationId, previous?.through_sequence ?? 0) as MessageRow[];
    if (rows.length < 2) return undefined;

    const visibleMessages = limitToolOutputs(
      rows.map(toCanonicalMessage),
      options.toolOutputTokenLimit,
    );
    const firstKeptIndex = compactionBoundary(
      rows,
      visibleMessages,
      options.keepRecentTokens,
    );
    if (firstKeptIndex <= 0) return undefined;

    const summarizedRows = rows.slice(0, firstKeptIndex);
    const target = summarizedRows.at(-1);
    if (!target) return undefined;
    return {
      previousSummary: previous?.summary ?? "",
      messages: summarizedRows.map(toCanonicalMessage),
      targetSequence: target.sequence,
      compactionCount: (previous?.compaction_count ?? 0) + 1,
      splitTurn: rows[firstKeptIndex]?.role !== "user",
    };
  }

  saveCompaction(input: ConversationCompactionInput): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO conversation_compactions
            (conversation_id, through_sequence, summary, source_token_estimate,
             summary_token_estimate, compaction_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             through_sequence=excluded.through_sequence,
             summary=excluded.summary,
             source_token_estimate=excluded.source_token_estimate,
             summary_token_estimate=excluded.summary_token_estimate,
             compaction_count=excluded.compaction_count,
             updated_at=excluded.updated_at`,
        )
        .run(
          input.conversationId,
          input.throughSequence,
          input.summary.trim(),
          input.sourceTokenEstimate,
          input.summaryTokenEstimate,
          input.compactionCount,
          now,
          now,
        );
      this.db
        .prepare(
          "DELETE FROM conversation_compaction_chunks WHERE conversation_id = ?",
        )
        .run(input.conversationId);
    })();
  }

  compactionChunk(
    conversationId: string,
    sourceHash: string,
  ): string | undefined {
    return (
      this.db
        .prepare(
          `SELECT summary FROM conversation_compaction_chunks
           WHERE conversation_id = ? AND source_hash = ?`,
        )
        .get(conversationId, sourceHash) as { summary: string } | undefined
    )?.summary;
  }

  saveCompactionChunk(input: {
    conversationId: string;
    sourceHash: string;
    summary: string;
    sourceTokenEstimate: number;
    summaryTokenEstimate: number;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conversation_compaction_chunks
          (conversation_id, source_hash, summary, source_token_estimate,
           summary_token_estimate, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, source_hash) DO UPDATE SET
           summary=excluded.summary,
           source_token_estimate=excluded.source_token_estimate,
           summary_token_estimate=excluded.summary_token_estimate,
           updated_at=excluded.updated_at`,
      )
      .run(
        input.conversationId,
        input.sourceHash,
        input.summary.trim(),
        input.sourceTokenEstimate,
        input.summaryTokenEstimate,
        now,
        now,
      );
  }

  deleteCompactionChunksBefore(timestamp: string): void {
    this.db
      .prepare(
        "DELETE FROM conversation_compaction_chunks WHERE updated_at < ?",
      )
      .run(timestamp);
  }

  processedEvent(eventId: string): string | undefined {
    return (
      this.db
        .prepare("SELECT response_json FROM processed_events WHERE event_id = ?")
        .get(eventId) as { response_json: string } | undefined
    )?.response_json;
  }

  saveProcessedEvent(eventId: string, responseJson: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO processed_events(event_id, response_json, processed_at)
         VALUES (?, ?, ?)`,
      )
      .run(eventId, responseJson, new Date().toISOString());
  }

  deleteProcessedEventsBefore(timestamp: string): void {
    this.db
      .prepare("DELETE FROM processed_events WHERE processed_at < ?")
      .run(timestamp);
  }

  private compactionRow(
    conversationId: string,
  ): ConversationCompactionRow | undefined {
    return this.db
      .prepare(
        `SELECT through_sequence, summary, source_token_estimate,
                summary_token_estimate, compaction_count
         FROM conversation_compactions
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as ConversationCompactionRow | undefined;
  }

  private compactedModelHistory(
    conversationId: string,
    compaction: ConversationCompactionRow,
  ): CanonicalMessage[] {
    const suffix = this.db
      .prepare(
        `SELECT rowid AS sequence, role, content, tool_calls_json, tool_call_id
         FROM messages
         WHERE conversation_id = ? AND rowid > ?
         ORDER BY rowid`,
      )
      .all(conversationId, compaction.through_sequence) as MessageRow[];
    return [
      {
        role: "user",
        content: formatCompactedContext(compaction.summary),
      },
      ...suffix.map(toCanonicalMessage),
    ];
  }

  private fullHistory(conversationId: string): CanonicalMessage[] {
    const rows = this.db
      .prepare(
        `SELECT rowid AS sequence, role, content, tool_calls_json, tool_call_id
         FROM messages
         WHERE conversation_id = ?
         ORDER BY rowid`,
      )
      .all(conversationId) as MessageRow[];
    return rows.map(toCanonicalMessage);
  }
}

function toCanonicalMessage(row: MessageRow): CanonicalMessage {
  const toolCalls = row.tool_calls_json
    ? (JSON.parse(row.tool_calls_json) as ToolCall[])
    : undefined;
  return {
    role: row.role,
    content: row.content,
    ...(toolCalls ? { toolCalls } : {}),
    ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
  };
}

function compactionBoundary(
  rows: MessageRow[],
  messages: CanonicalMessage[],
  keepRecentTokens: number,
): number {
  let retainedTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    retainedTokens += estimateMessageTokens(messages[index]!);
    if (retainedTokens < Math.max(1, keepRecentTokens)) continue;

    let boundary = index;
    while (boundary > 0 && rows[boundary]?.role === "tool") {
      boundary -= 1;
    }
    return boundary;
  }
  return -1;
}
