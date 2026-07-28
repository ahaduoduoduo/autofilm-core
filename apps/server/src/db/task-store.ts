import { randomUUID } from "node:crypto";
import type { TaskState, TaskSummary } from "@autofilm/contracts";
import type { AppDatabase } from "./database.js";

interface TaskRow {
  id: string;
  user_id: string | null;
  type: string;
  title: string;
  state: TaskState;
  progress: number | null;
  status_text: string;
  external_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export class TaskStore {
  constructor(private readonly db: AppDatabase) {}

  create(input: {
    userId?: string | null;
    type: string;
    title: string;
    state?: TaskState;
    externalId?: string;
    metadata?: Record<string, unknown>;
  }): TaskSummary {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks
          (id, user_id, type, title, state, external_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId ?? null,
        input.type,
        input.title,
        input.state ?? "queued",
        input.externalId ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): TaskSummary | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    return row ? toTask(row) : undefined;
  }

  list(limit = 100): TaskSummary[] {
    return (
      this.db
        .prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?")
        .all(limit) as TaskRow[]
    ).map(toTask);
  }

  activeByExternalId(externalId: string): TaskSummary | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE external_id = ? AND state IN ('queued', 'running', 'waiting')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(externalId) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  byExternalId(externalId: string): TaskSummary | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks WHERE external_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(externalId) as TaskRow | undefined;
    return row ? toTask(row) : undefined;
  }

  update(
    id: string,
    input: {
      state?: TaskState;
      progress?: number | null;
      statusText?: string;
      externalId?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): TaskSummary {
    const current = this.get(id);
    if (!current) throw new Error("Task not found");
    const state = input.state ?? current.state;
    const terminal = ["completed", "failed", "cancelled"].includes(state);
    this.db
      .prepare(
        `UPDATE tasks SET
           state = ?, progress = ?, status_text = ?, external_id = ?,
           metadata_json = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        input.progress === undefined ? current.progress : input.progress,
        input.statusText ?? current.statusText,
        input.externalId === undefined ? current.externalId : input.externalId,
        JSON.stringify(input.metadata ?? current.metadata),
        new Date().toISOString(),
        terminal ? new Date().toISOString() : current.completedAt,
        id,
      );
    return this.get(id)!;
  }
}

function toTask(row: TaskRow): TaskSummary {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    state: row.state,
    progress: row.progress,
    statusText: row.status_text,
    externalId: row.external_id,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
