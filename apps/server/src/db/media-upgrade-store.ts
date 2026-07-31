import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";

export type MediaUpgradeState =
  | "searching"
  | "awaiting_selection"
  | "search_failed"
  | "downloading"
  | "awaiting_alternative"
  | "inspecting"
  | "activating"
  | "succeeded"
  | "succeeded_with_backup_error"
  | "rolled_back"
  | "failed"
  | "abandoned";

export interface MediaUpgradeCandidate {
  id: string;
  title: string;
  downloadUrl: string;
  size: number;
  seeders: number;
  peers: number;
  tracker: string;
  publishDate: string;
}

export interface MediaUpgradeItem {
  id: string;
  jobId: string;
  jellyfinItemId: string;
  title: string;
  query: string;
  state: MediaUpgradeState;
  current: Record<string, unknown>;
  candidates: MediaUpgradeCandidate[];
  selectedCandidateId?: string;
  downloadTaskId?: string;
  newPath?: string;
  backupPath?: string;
  rollbackToken?: string;
  error: string;
  createdAt: string;
  updatedAt: string;
}

interface ItemRow {
  id: string;
  job_id: string;
  jellyfin_item_id: string;
  title: string;
  query: string;
  state: MediaUpgradeState;
  current_json: string;
  candidates_json: string;
  selected_candidate_id: string | null;
  download_task_id: string | null;
  new_path: string | null;
  backup_path: string | null;
  rollback_token: string | null;
  error: string;
  created_at: string;
  updated_at: string;
}

export class MediaUpgradeStore {
  constructor(private readonly db: AppDatabase) {}

  createJob(userId: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO media_upgrade_jobs(id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, userId, now, now);
    return id;
  }

  jobOwner(jobId: string): string | undefined {
    return (
      this.db
        .prepare("SELECT user_id FROM media_upgrade_jobs WHERE id = ?")
        .get(jobId) as { user_id: string } | undefined
    )?.user_id;
  }

  createItem(input: {
    jobId: string;
    jellyfinItemId: string;
    title: string;
    query: string;
    current: Record<string, unknown>;
  }): MediaUpgradeItem {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO media_upgrade_items
          (id, job_id, jellyfin_item_id, title, query, state, current_json,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'searching', ?, ?, ?)`,
      )
      .run(
        id,
        input.jobId,
        input.jellyfinItemId,
        input.title,
        input.query,
        JSON.stringify(input.current),
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): MediaUpgradeItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM media_upgrade_items WHERE id = ?")
      .get(id) as ItemRow | undefined;
    return row ? toItem(row) : undefined;
  }

  items(jobId: string): MediaUpgradeItem[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM media_upgrade_items WHERE job_id = ? ORDER BY created_at",
        )
        .all(jobId) as ItemRow[]
    ).map(toItem);
  }

  dueForProcessing(limit = 20): MediaUpgradeItem[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM media_upgrade_items
           WHERE state IN ('downloading', 'inspecting', 'activating')
              OR (state = 'succeeded' AND backup_path IS NULL)
           ORDER BY updated_at LIMIT ?`,
        )
        .all(limit) as ItemRow[]
    ).map(toItem);
  }

  update(
    id: string,
    input: Partial<{
      state: MediaUpgradeState;
      current: Record<string, unknown>;
      candidates: MediaUpgradeCandidate[];
      selectedCandidateId: string | null;
      downloadTaskId: string | null;
      newPath: string | null;
      backupPath: string | null;
      rollbackToken: string | null;
      error: string;
    }>,
  ): MediaUpgradeItem {
    const current = this.get(id);
    if (!current) throw new Error("Media upgrade item not found");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE media_upgrade_items SET state = ?, current_json = ?,
           candidates_json = ?, selected_candidate_id = ?,
           download_task_id = ?, new_path = ?, backup_path = ?,
           rollback_token = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.state ?? current.state,
        JSON.stringify(input.current ?? current.current),
        JSON.stringify(input.candidates ?? current.candidates),
        input.selectedCandidateId === undefined
          ? current.selectedCandidateId ?? null
          : input.selectedCandidateId,
        input.downloadTaskId === undefined
          ? current.downloadTaskId ?? null
          : input.downloadTaskId,
        input.newPath === undefined ? current.newPath ?? null : input.newPath,
        input.backupPath === undefined
          ? current.backupPath ?? null
          : input.backupPath,
        input.rollbackToken === undefined
          ? current.rollbackToken ?? null
          : input.rollbackToken,
        input.error ?? current.error,
        now,
        id,
      );
    this.db
      .prepare("UPDATE media_upgrade_jobs SET updated_at = ? WHERE id = ?")
      .run(now, current.jobId);
    return this.get(id)!;
  }
}

function toItem(row: ItemRow): MediaUpgradeItem {
  return {
    id: row.id,
    jobId: row.job_id,
    jellyfinItemId: row.jellyfin_item_id,
    title: row.title,
    query: row.query,
    state: row.state,
    current: JSON.parse(row.current_json) as Record<string, unknown>,
    candidates: JSON.parse(row.candidates_json) as MediaUpgradeCandidate[],
    selectedCandidateId: row.selected_candidate_id ?? undefined,
    downloadTaskId: row.download_task_id ?? undefined,
    newPath: row.new_path ?? undefined,
    backupPath: row.backup_path ?? undefined,
    rollbackToken: row.rollback_token ?? undefined,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
