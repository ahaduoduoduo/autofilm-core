import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";
import type { CanonicalMessage, ToolCall } from "../ai/types.js";
import { limitToolOutputs } from "../ai/token-budget.js";
import {
  type ConversationCompactionInput,
  type ConversationCompactionPlan,
  type ConversationCompactionRow,
  formatCompactedContext,
  parseRetainedUserMessages,
} from "./conversation-compaction.js";
import { formatTopicMemory } from "./conversation-topic.js";

export type { ConversationCompactionInput, ConversationCompactionPlan } from "./conversation-compaction.js";

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

export interface MediaTopic {
  mediaType: "movie" | "tv";
  tmdbId: number;
  title: string;
  productionYear?: number;
}

export interface TopicSummary {
  topicKey: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
  title: string;
  productionYear?: number;
  summary: string;
}

export interface TopicSwitchPlan {
  changed: boolean;
  previous?: TopicSummary;
  messages: CanonicalMessage[];
}

interface TopicStateRow {
  topic_key: string;
  media_type: "movie" | "tv";
  tmdb_id: number;
  title: string;
  production_year: number | null;
  started_message_id: string;
}

interface TopicSummaryRow {
  topic_key: string;
  media_type: "movie" | "tv";
  tmdb_id: number;
  title: string;
  production_year: number | null;
  summary: string;
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
    if (row) {
      this.db.transaction(() => {
        this.db
          .prepare(
            "DELETE FROM conversation_topic_state WHERE conversation_id = ?",
          )
          .run(row.id);
        this.db
          .prepare(
            "DELETE FROM conversation_topic_summaries WHERE conversation_id = ?",
          )
          .run(row.id);
        this.db
          .prepare(
            "DELETE FROM conversation_compactions WHERE conversation_id = ?",
          )
          .run(row.id);
        this.db
          .prepare("DELETE FROM messages WHERE conversation_id = ?")
          .run(row.id);
      })();
    }
  }

  history(conversationId: string, limit = 80): CanonicalMessage[] {
    let rows = this.db
      .prepare(
        `SELECT sequence, role, content, tool_calls_json, tool_call_id FROM (
           SELECT rowid AS sequence, role, content, tool_calls_json, tool_call_id
           FROM messages
           WHERE conversation_id = ?
           ORDER BY rowid DESC
           LIMIT ?
         )
         ORDER BY sequence`,
      )
      .all(conversationId, Math.max(1, limit)) as MessageRow[];
    const first = rows[0];
    if (first && first.role !== "user") {
      const turnStart = this.db
        .prepare(
          `SELECT rowid AS sequence
           FROM messages
           WHERE conversation_id = ? AND rowid < ? AND role = 'user'
           ORDER BY rowid DESC
           LIMIT 1`,
        )
        .get(conversationId, first.sequence) as
        | { sequence: number }
        | undefined;
      if (turnStart) {
        rows = this.db
          .prepare(
            `SELECT rowid AS sequence, role, content, tool_calls_json,
                    tool_call_id
             FROM messages
             WHERE conversation_id = ? AND rowid >= ?
             ORDER BY rowid`,
          )
          .all(conversationId, turnStart.sequence) as MessageRow[];
      }
    }
    return rows.map(toCanonicalMessage);
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
    options: { limit?: number; toolOutputTokenLimit?: number } = {},
  ): {
    messages: CanonicalMessage[];
    memory: string;
  } {
    const limit = options.limit ?? 80;
    const state = this.topicState(conversationId);
    const activeStartSequence = state
      ? this.messageSequence(conversationId, state.started_message_id) ?? 0
      : 0;
    const compaction = this.compactionRow(conversationId);
    const messages = compaction &&
        compaction.through_sequence >= activeStartSequence
      ? this.compactedModelHistory(conversationId, compaction)
      : state
      ? this.historyStartingAt(
          conversationId,
          state.started_message_id,
          limit,
        )
      : this.history(conversationId, limit);
    const summaries = this.topicSummaries(conversationId, 12);
    return {
      messages: options.toolOutputTokenLimit
        ? limitToolOutputs(messages, options.toolOutputTokenLimit)
        : messages,
      memory: formatTopicMemory(summaries),
    };
  }

  compactionPlan(
    conversationId: string,
  ): ConversationCompactionPlan | undefined {
    const state = this.topicState(conversationId);
    const topicStartSequence = state
      ? this.messageSequence(conversationId, state.started_message_id) ?? 0
      : 0;
    const retainedStartId = this.retainedHistoryStartMessageId(
      conversationId,
      80,
    );
    const retainedStartSequence = retainedStartId
      ? this.messageSequence(conversationId, retainedStartId) ?? 0
      : 0;
    const initialStartSequence = Math.max(
      topicStartSequence,
      retainedStartSequence,
    );
    const previous = this.compactionRow(conversationId);
    const previousApplies = Boolean(
      previous && previous.through_sequence >= topicStartSequence,
    );
    const startSequence = previousApplies
      ? previous!.through_sequence + 1
      : initialStartSequence;
    const rows = this.db
      .prepare(
        `SELECT rowid AS sequence, role, content, tool_calls_json, tool_call_id
         FROM messages
         WHERE conversation_id = ? AND rowid >= ?
         ORDER BY rowid`,
      )
      .all(conversationId, startSequence) as MessageRow[];
    const last = rows.at(-1);
    if (!last) return undefined;
    return {
      previousSummary: previousApplies ? previous!.summary : "",
      previousRetainedUserMessages: previousApplies
        ? parseRetainedUserMessages(previous!.retained_user_messages_json)
        : [],
      messages: rows.map(toCanonicalMessage),
      targetSequence: last.sequence,
      compactionCount: previousApplies ? previous!.compaction_count + 1 : 1,
    };
  }

  saveCompaction(input: ConversationCompactionInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conversation_compactions
          (conversation_id, through_sequence, summary,
           retained_user_messages_json, source_token_estimate,
           summary_token_estimate, compaction_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           through_sequence=excluded.through_sequence,
           summary=excluded.summary,
           retained_user_messages_json=excluded.retained_user_messages_json,
           source_token_estimate=excluded.source_token_estimate,
           summary_token_estimate=excluded.summary_token_estimate,
           compaction_count=excluded.compaction_count,
           updated_at=excluded.updated_at`,
      )
      .run(
        input.conversationId,
        input.throughSequence,
        input.summary.trim(),
        JSON.stringify(input.retainedUserMessages),
        input.sourceTokenEstimate,
        input.summaryTokenEstimate,
        input.compactionCount,
        now,
        now,
      );
  }

  planTopicSwitch(
    conversationId: string,
    topic: MediaTopic,
    currentTurnMessageId: string,
  ): TopicSwitchPlan {
    const state = this.topicState(conversationId);
    const nextKey = topicKey(topic);
    if (state?.topic_key === nextKey) {
      return { changed: false, messages: [] };
    }
    if (!state) {
      return { changed: true, messages: [] };
    }
    const previousSummary = this.db
      .prepare(
        `SELECT topic_key, media_type, tmdb_id, title, production_year, summary
         FROM conversation_topic_summaries
         WHERE conversation_id = ? AND topic_key = ?`,
      )
      .get(conversationId, state.topic_key) as TopicSummaryRow | undefined;
    return {
      changed: true,
      previous: {
        topicKey: state.topic_key,
        mediaType: state.media_type,
        tmdbId: state.tmdb_id,
        title: state.title,
        productionYear: state.production_year ?? undefined,
        summary: previousSummary?.summary ?? "",
      },
      messages: this.messagesInTopic(
        conversationId,
        state.started_message_id,
        currentTurnMessageId,
      ),
    };
  }

  commitTopicSwitch(
    conversationId: string,
    topic: MediaTopic,
    currentTurnMessageId: string,
    previous?: TopicSummary,
  ): void {
    const now = new Date().toISOString();
    const startedMessageId = this.topicState(conversationId)
      ? currentTurnMessageId
      : this.retainedHistoryStartMessageId(conversationId, 80) ??
        currentTurnMessageId;
    this.db.transaction(() => {
      if (previous?.summary.trim()) {
        this.db
          .prepare(
            `INSERT INTO conversation_topic_summaries
              (id, conversation_id, topic_key, media_type, tmdb_id, title,
               production_year, summary, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(conversation_id, topic_key) DO UPDATE SET
               media_type=excluded.media_type,
               tmdb_id=excluded.tmdb_id,
               title=excluded.title,
               production_year=excluded.production_year,
               summary=excluded.summary,
               updated_at=excluded.updated_at`,
          )
          .run(
            randomUUID(),
            conversationId,
            previous.topicKey,
            previous.mediaType,
            previous.tmdbId,
            previous.title,
            previous.productionYear ?? null,
            previous.summary.trim(),
            now,
            now,
          );
      }
      this.db
        .prepare(
          `INSERT INTO conversation_topic_state
            (conversation_id, topic_key, media_type, tmdb_id, title,
             production_year, started_message_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(conversation_id) DO UPDATE SET
             topic_key=excluded.topic_key,
             media_type=excluded.media_type,
             tmdb_id=excluded.tmdb_id,
             title=excluded.title,
             production_year=excluded.production_year,
             started_message_id=excluded.started_message_id,
             updated_at=excluded.updated_at`,
        )
        .run(
          conversationId,
          topicKey(topic),
          topic.mediaType,
          topic.tmdbId,
          topic.title,
          topic.productionYear ?? null,
          startedMessageId,
          now,
        );
    })();
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

  private topicState(conversationId: string): TopicStateRow | undefined {
    return this.db
      .prepare(
        `SELECT topic_key, media_type, tmdb_id, title, production_year,
                started_message_id
         FROM conversation_topic_state
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as TopicStateRow | undefined;
  }

  private compactionRow(
    conversationId: string,
  ): ConversationCompactionRow | undefined {
    return this.db
      .prepare(
        `SELECT through_sequence, summary, retained_user_messages_json,
                source_token_estimate, summary_token_estimate, compaction_count
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
        content: formatCompactedContext(
          compaction.summary,
          parseRetainedUserMessages(compaction.retained_user_messages_json),
        ),
      },
      ...suffix.map(toCanonicalMessage),
    ];
  }

  private messageSequence(
    conversationId: string,
    messageId: string,
  ): number | undefined {
    return (
      this.db
        .prepare(
          `SELECT rowid AS sequence FROM messages
           WHERE conversation_id = ? AND id = ?`,
        )
        .get(conversationId, messageId) as { sequence: number } | undefined
    )?.sequence;
  }

  private topicSummaries(
    conversationId: string,
    limit: number,
  ): TopicSummary[] {
    return (
      this.db
        .prepare(
          `SELECT topic_key, media_type, tmdb_id, title, production_year, summary
           FROM conversation_topic_summaries
           WHERE conversation_id = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(conversationId, limit) as TopicSummaryRow[]
    ).map((row) => ({
      topicKey: row.topic_key,
      mediaType: row.media_type,
      tmdbId: row.tmdb_id,
      title: row.title,
      productionYear: row.production_year ?? undefined,
      summary: row.summary,
    }));
  }

  private historyStartingAt(
    conversationId: string,
    messageId: string,
    limit: number,
  ): CanonicalMessage[] {
    const boundary = this.db
      .prepare(
        `SELECT rowid AS sequence FROM messages
         WHERE conversation_id = ? AND id = ?`,
      )
      .get(conversationId, messageId) as { sequence: number } | undefined;
    if (!boundary) return this.history(conversationId, limit);
    let rows = this.db
      .prepare(
        `SELECT sequence, role, content, tool_calls_json, tool_call_id FROM (
           SELECT rowid AS sequence, role, content, tool_calls_json, tool_call_id
           FROM messages
           WHERE conversation_id = ? AND rowid >= ?
           ORDER BY rowid DESC
           LIMIT ?
         )
         ORDER BY sequence`,
      )
      .all(
        conversationId,
        boundary.sequence,
        Math.max(1, limit),
      ) as MessageRow[];
    rows = expandToTurnStart(this.db, conversationId, rows, boundary.sequence);
    return rows.map(toCanonicalMessage);
  }

  private retainedHistoryStartMessageId(
    conversationId: string,
    limit: number,
  ): string | undefined {
    const first = this.db
      .prepare(
        `SELECT id, sequence, role FROM (
           SELECT id, rowid AS sequence, role
           FROM messages
           WHERE conversation_id = ?
           ORDER BY rowid DESC
           LIMIT ?
         )
         ORDER BY sequence
         LIMIT 1`,
      )
      .get(conversationId, Math.max(1, limit)) as
      | {
          id: string;
          sequence: number;
          role: "user" | "assistant" | "tool";
        }
      | undefined;
    if (!first || first.role === "user") return first?.id;
    const turnStart = this.db
      .prepare(
        `SELECT id FROM messages
         WHERE conversation_id = ? AND rowid < ? AND role = 'user'
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(conversationId, first.sequence) as { id: string } | undefined;
    return turnStart?.id ?? first.id;
  }

  private messagesInTopic(
    conversationId: string,
    startedMessageId: string,
    currentTurnMessageId: string,
  ): CanonicalMessage[] {
    const boundaries = this.db
      .prepare(
        `SELECT
           (SELECT rowid FROM messages WHERE conversation_id = ? AND id = ?)
             AS start_sequence,
           (SELECT rowid FROM messages WHERE conversation_id = ? AND id = ?)
             AS end_sequence`,
      )
      .get(
        conversationId,
        startedMessageId,
        conversationId,
        currentTurnMessageId,
      ) as
      | { start_sequence: number | null; end_sequence: number | null }
      | undefined;
    if (!boundaries?.start_sequence || !boundaries.end_sequence) return [];
    const rows = this.db
      .prepare(
        `SELECT rowid AS sequence, role, content, tool_calls_json, tool_call_id
         FROM messages
         WHERE conversation_id = ? AND rowid >= ? AND rowid < ?
         ORDER BY rowid`,
      )
      .all(
        conversationId,
        boundaries.start_sequence,
        boundaries.end_sequence,
      ) as MessageRow[];
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

function topicKey(topic: MediaTopic): string {
  return `${topic.mediaType}:tmdb:${topic.tmdbId}`;
}

function expandToTurnStart(
  db: AppDatabase,
  conversationId: string,
  rows: MessageRow[],
  minimumSequence = 0,
): MessageRow[] {
  const first = rows[0];
  if (!first || first.role === "user") return rows;
  const turnStart = db
    .prepare(
      `SELECT rowid AS sequence
       FROM messages
       WHERE conversation_id = ? AND rowid < ? AND rowid >= ? AND role = 'user'
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(conversationId, first.sequence, minimumSequence) as
    | { sequence: number }
    | undefined;
  if (!turnStart) return rows;
  return db
    .prepare(
      `SELECT rowid AS sequence, role, content, tool_calls_json, tool_call_id
       FROM messages
       WHERE conversation_id = ? AND rowid >= ?
       ORDER BY rowid`,
    )
    .all(conversationId, turnStart.sequence) as MessageRow[];
}
