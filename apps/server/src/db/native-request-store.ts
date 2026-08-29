import type { AppDatabase } from "./database.js";

export type NativeRequestEventType =
  | "message.created"
  | "conversation.reset";

export interface NativeRequestJob {
  eventId: string;
  userId: string;
  channel: string;
  providerInstanceId: string;
  externalConversationId: string;
  eventType: NativeRequestEventType;
  text: string;
  state: "pending" | "running" | "completed" | "failed";
  lastError: string;
}

interface NativeRequestRow {
  event_id: string;
  user_id: string;
  channel: string;
  provider_instance_id: string;
  external_conversation_id: string;
  event_type: NativeRequestEventType;
  text: string;
  state: NativeRequestJob["state"];
  last_error: string;
}

export class NativeRequestStore {
  constructor(private readonly db: AppDatabase) {}

  enqueue(input: {
    eventId: string;
    userId: string;
    channel: string;
    providerInstanceId: string;
    externalConversationId: string;
    eventType: NativeRequestEventType;
    text?: string;
  }): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO native_request_jobs
          (event_id, user_id, channel, provider_instance_id,
           external_conversation_id, event_type, text, state,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        input.eventId,
        input.userId,
        input.channel,
        input.providerInstanceId,
        input.externalConversationId,
        input.eventType,
        input.text ?? "",
        now,
        now,
      );
    return result.changes === 1;
  }

  get(eventId: string): NativeRequestJob | undefined {
    const row = this.db
      .prepare("SELECT * FROM native_request_jobs WHERE event_id = ?")
      .get(eventId) as NativeRequestRow | undefined;
    return row ? toJob(row) : undefined;
  }

  claimPending(limit: number): NativeRequestJob[] {
    if (limit <= 0) return [];
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM native_request_jobs
           WHERE state = 'pending'
           ORDER BY sequence
           LIMIT ?`,
        )
        .all(limit) as NativeRequestRow[];
      const now = new Date().toISOString();
      const mark = this.db.prepare(
        `UPDATE native_request_jobs
         SET state = 'running', updated_at = ?
         WHERE event_id = ? AND state = 'pending'`,
      );
      const claimed: NativeRequestJob[] = [];
      for (const row of rows) {
        if (mark.run(now, row.event_id).changes === 1) {
          claimed.push(toJob({ ...row, state: "running" }));
        }
      }
      return claimed;
    })();
  }

  markCompleted(eventId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE native_request_jobs
         SET state = 'completed', last_error = '', updated_at = ?,
             completed_at = ?
         WHERE event_id = ?`,
      )
      .run(now, now, eventId);
  }

  markFailed(eventId: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE native_request_jobs
         SET state = 'failed', last_error = ?, updated_at = ?,
             completed_at = ?
         WHERE event_id = ?`,
      )
      .run(error.slice(0, 1000), now, now, eventId);
  }

  recoverInterrupted(): NativeRequestJob[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM native_request_jobs
           WHERE state = 'running'
           ORDER BY sequence`,
        )
        .all() as NativeRequestRow[];
      if (rows.length === 0) return [];
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE native_request_jobs
           SET state = 'failed', last_error = ?, updated_at = ?,
               completed_at = ?
           WHERE state = 'running'`,
        )
        .run("Core restarted while the request was running", now, now);
      return rows.map((row) =>
        toJob({
          ...row,
          state: "failed",
          last_error: "Core restarted while the request was running",
        }),
      );
    })();
  }

  deleteFinishedBefore(timestamp: string): void {
    this.db
      .prepare(
        `DELETE FROM native_request_jobs
         WHERE state IN ('completed', 'failed') AND updated_at < ?`,
      )
      .run(timestamp);
  }
}

function toJob(row: NativeRequestRow): NativeRequestJob {
  return {
    eventId: row.event_id,
    userId: row.user_id,
    channel: row.channel,
    providerInstanceId: row.provider_instance_id,
    externalConversationId: row.external_conversation_id,
    eventType: row.event_type,
    text: row.text,
    state: row.state,
    lastError: row.last_error,
  };
}
