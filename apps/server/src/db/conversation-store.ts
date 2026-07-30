import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";
import type { CanonicalMessage, ToolCall } from "../ai/types.js";

interface ConversationRow {
  id: string;
}

interface MessageRow {
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
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(row.id);
    }
  }

  history(conversationId: string, limit = 80): CanonicalMessage[] {
    const rows = this.db
      .prepare(
        `SELECT role, content, tool_calls_json, tool_call_id FROM (
           SELECT * FROM messages WHERE conversation_id = ?
           ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at`,
      )
      .all(conversationId, limit) as MessageRow[];
    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      toolCalls: row.tool_calls_json
        ? (JSON.parse(row.tool_calls_json) as ToolCall[])
        : undefined,
      toolCallId: row.tool_call_id ?? undefined,
    }));
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
