import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";
import type { CanonicalMessage, ToolCall } from "../ai/types.js";

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
      this.db
        .prepare("DELETE FROM messages WHERE conversation_id = ?")
        .run(row.id);
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

  append(conversationId: string, message: CanonicalMessage): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messages
          (id, conversation_id, role, content, tool_calls_json, tool_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
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
