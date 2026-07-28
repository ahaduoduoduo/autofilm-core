import { randomUUID } from "node:crypto";
import type {
  NativeOutboundMessage,
  TaskSummary,
} from "@autofilm/contracts";
import type { AppDatabase } from "./database.js";

export interface OutboxMessage {
  id: string;
  userId: string | null;
  channel: string | null;
  providerInstanceId: string | null;
  targetId: string | null;
  payload: { messages: NativeOutboundMessage[] };
  attempts: number;
}

interface OutboxRow {
  id: string;
  user_id: string | null;
  channel: string | null;
  provider_instance_id: string | null;
  target_id: string | null;
  payload_json: string;
  attempts: number;
}

export class OutboxStore {
  constructor(private readonly db: AppDatabase) {}

  enqueueTaskResult(task: TaskSummary): void {
    if (!task.userId) return;
    const target = isTarget(task.metadata.notificationTarget)
      ? task.metadata.notificationTarget
      : undefined;
    const status =
      task.state === "completed"
        ? "已完成"
        : task.state === "cancelled"
          ? "已取消"
          : "失败";
    const detail = task.statusText ? `\n${task.statusText}` : "";
    this.enqueue({
      userId: task.userId,
      channel: target?.channel,
      providerInstanceId: target?.providerInstanceId,
      targetId: target?.targetId,
      text: `AutoFilm 任务${status}：${task.title}${detail}`,
    });
  }

  enqueue(input: {
    userId?: string | null;
    channel?: string;
    providerInstanceId?: string;
    targetId?: string;
    text: string;
  }): void {
    this.enqueueMessages({
      userId: input.userId,
      channel: input.channel,
      providerInstanceId: input.providerInstanceId,
      targetId: input.targetId,
      messages: [{ type: "text", text: input.text }],
    });
  }

  enqueueMessages(input: {
    userId?: string | null;
    channel?: string;
    providerInstanceId?: string;
    targetId?: string;
    messages: NativeOutboundMessage[];
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO outbox_messages
          (id, user_id, channel, provider_instance_id, target_id, payload_json,
           state, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.userId ?? null,
        input.channel ?? null,
        input.providerInstanceId ?? null,
        input.targetId ?? null,
        JSON.stringify({ messages: input.messages }),
        now,
        now,
        now,
      );
  }

  claimDue(limit = 20): OutboxMessage[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM outbox_messages
           WHERE state = 'pending' AND next_attempt_at <= ?
           ORDER BY created_at LIMIT ?`,
        )
        .all(new Date().toISOString(), limit) as OutboxRow[];
      const mark = this.db.prepare(
        `UPDATE outbox_messages SET state = 'sending', updated_at = ?
         WHERE id = ?`,
      );
      const now = new Date().toISOString();
      for (const row of rows) mark.run(now, row.id);
      return rows.map(toMessage);
    })();
  }

  markSent(id: string): void {
    this.db
      .prepare(
        `UPDATE outbox_messages
         SET state = 'sent', updated_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
  }

  markFailed(id: string, attempts: number, error: string): void {
    const nextAttempts = attempts + 1;
    const terminal = nextAttempts >= 10;
    const delayMs = Math.min(60 * 60_000, 2 ** nextAttempts * 5_000);
    this.db
      .prepare(
        `UPDATE outbox_messages SET state = ?, attempts = ?,
           next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        terminal ? "failed" : "pending",
        nextAttempts,
        new Date(Date.now() + delayMs).toISOString(),
        error.slice(0, 1000),
        new Date().toISOString(),
        id,
      );
  }
}

function toMessage(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    providerInstanceId: row.provider_instance_id,
    targetId: row.target_id,
    payload: JSON.parse(row.payload_json) as OutboxMessage["payload"],
    attempts: row.attempts,
  };
}

function isTarget(value: unknown): value is {
  channel: string;
  providerInstanceId: string;
  targetId: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "channel" in value &&
    "providerInstanceId" in value &&
    "targetId" in value &&
    typeof value.channel === "string" &&
    typeof value.providerInstanceId === "string" &&
    typeof value.targetId === "string"
  );
}
