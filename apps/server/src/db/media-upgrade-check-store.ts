import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";

export interface UpgradeCheckNotificationTarget {
  channel: string;
  providerInstanceId: string;
  targetId: string;
}

export type UpgradeCheckResolution = "1080p" | "2160p" | "4320p";
export type UpgradeCheckItemState =
  | "pending"
  | "running"
  | "matched"
  | "no_match"
  | "failed";

export interface UpgradeCheckCandidate {
  title: string;
  size: number;
  seeders: number;
  peers: number;
  tracker: string;
  publishDate: string;
}

export interface UpgradeCheckItem {
  id: string;
  jobId: string;
  jellyfinItemId: string;
  title: string;
  originalTitle: string;
  productionYear?: number;
  currentResolution: string;
  query: string;
  state: UpgradeCheckItemState;
  candidateCount: number;
  candidates: UpgradeCheckCandidate[];
  error: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpgradeCheckJob {
  id: string;
  userId: string;
  targetResolution: UpgradeCheckResolution;
  state: "pending" | "running" | "completed";
  notificationTarget?: UpgradeCheckNotificationTarget;
  notificationState: "none" | "pending" | "running" | "sent" | "failed";
  notificationAttempts: number;
  notificationNextAt?: string;
  notificationError: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface UpgradeCheckSummary {
  jobId: string;
  state: UpgradeCheckJob["state"];
  targetResolution: UpgradeCheckResolution;
  total: number;
  checked: number;
  matched: number;
  noMatch: number;
  failed: number;
  pending: number;
  running: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface JobRow {
  id: string;
  user_id: string;
  target_resolution: UpgradeCheckResolution;
  state: UpgradeCheckJob["state"];
  notification_target_json: string | null;
  notification_state: UpgradeCheckJob["notificationState"];
  notification_attempts: number;
  notification_next_at: string | null;
  notification_error: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface ItemRow {
  id: string;
  job_id: string;
  jellyfin_item_id: string;
  title: string;
  original_title: string;
  production_year: number | null;
  current_resolution: string;
  query: string;
  state: UpgradeCheckItemState;
  candidate_count: number;
  candidates_json: string;
  error: string;
  created_at: string;
  updated_at: string;
}

export class MediaUpgradeCheckStore {
  constructor(private readonly db: AppDatabase) {}

  create(input: {
    userId: string;
    targetResolution: UpgradeCheckResolution;
    notificationTarget?: UpgradeCheckNotificationTarget;
    targets: Array<{
      jellyfinItemId: string;
      title: string;
      originalTitle?: string;
      productionYear?: number;
      currentResolution: string;
    }>;
  }): UpgradeCheckJob {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO media_upgrade_check_jobs
            (id, user_id, target_resolution, state, notification_target_json,
             created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          id,
          input.userId,
          input.targetResolution,
          input.notificationTarget
            ? JSON.stringify(input.notificationTarget)
            : null,
          now,
          now,
        );
      const insert = this.db.prepare(
        `INSERT INTO media_upgrade_check_items
          (id, job_id, jellyfin_item_id, title, original_title,
           production_year, current_resolution, query, state, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      );
      for (const target of input.targets) {
        insert.run(
          randomUUID(),
          id,
          target.jellyfinItemId,
          target.title,
          target.originalTitle ?? "",
          target.productionYear ?? null,
          target.currentResolution,
          buildQuery(target),
          now,
          now,
        );
      }
    })();
    return this.job(id)!;
  }

  job(id: string, userId?: string): UpgradeCheckJob | undefined {
    const row = userId
      ? (this.db
          .prepare(
            "SELECT * FROM media_upgrade_check_jobs WHERE id = ? AND user_id = ?",
          )
          .get(id, userId) as JobRow | undefined)
      : (this.db
          .prepare("SELECT * FROM media_upgrade_check_jobs WHERE id = ?")
          .get(id) as JobRow | undefined);
    return row ? toJob(row) : undefined;
  }

  summary(id: string, userId?: string): UpgradeCheckSummary | undefined {
    const job = this.job(id, userId);
    if (!job) return undefined;
    const counts = this.counts(id);
    return {
      jobId: job.id,
      state: job.state,
      targetResolution: job.targetResolution,
      ...counts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
    };
  }

  claim(limit: number, staleBefore: string): UpgradeCheckItem[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT i.* FROM media_upgrade_check_items i
           JOIN media_upgrade_check_jobs j ON j.id = i.job_id
           WHERE i.state = 'pending'
              OR (i.state = 'running' AND i.updated_at <= ?)
           ORDER BY j.created_at, i.created_at
           LIMIT ?`,
        )
        .all(staleBefore, limit) as ItemRow[];
      if (rows.length === 0) return [];
      const now = new Date().toISOString();
      const markItem = this.db.prepare(
        `UPDATE media_upgrade_check_items
         SET state = 'running', updated_at = ? WHERE id = ?`,
      );
      const markJob = this.db.prepare(
        `UPDATE media_upgrade_check_jobs
         SET state = 'running', updated_at = ? WHERE id = ?`,
      );
      for (const row of rows) {
        markItem.run(now, row.id);
        markJob.run(now, row.job_id);
      }
      return rows.map((row) =>
        toItem({ ...row, state: "running", updated_at: now }),
      );
    })();
  }

  completeItem(input: {
    id: string;
    state: "matched" | "no_match" | "failed";
    candidates?: UpgradeCheckCandidate[];
    candidateCount?: number;
    error?: string;
  }): void {
    const item = this.item(input.id);
    if (!item) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE media_upgrade_check_items
         SET state = ?, candidate_count = ?, candidates_json = ?, error = ?,
             updated_at = ? WHERE id = ?`,
      )
      .run(
        input.state,
        input.candidateCount ?? input.candidates?.length ?? 0,
        JSON.stringify(input.candidates ?? []),
        input.error ?? "",
        now,
        input.id,
      );
    this.finalizeIfComplete(item.jobId, now);
  }

  matchedResults(input: {
    jobId: string;
    userId: string;
    page: number;
    limit: number;
  }): { total: number; items: UpgradeCheckItem[] } | undefined {
    if (!this.job(input.jobId, input.userId)) return undefined;
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS total FROM media_upgrade_check_items
           WHERE job_id = ? AND state = 'matched'`,
        )
        .get(input.jobId) as { total: number }
    ).total;
    const rows = this.db
      .prepare(
        `SELECT * FROM media_upgrade_check_items
         WHERE job_id = ? AND state = 'matched'
         ORDER BY title COLLATE NOCASE, production_year, created_at
         LIMIT ? OFFSET ?`,
      )
      .all(
        input.jobId,
        input.limit,
        input.page * input.limit,
      ) as ItemRow[];
    return { total, items: rows.map(toItem) };
  }

  dueNotifications(staleBefore: string, limit = 5): UpgradeCheckJob[] {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare(
          `SELECT * FROM media_upgrade_check_jobs
           WHERE state = 'completed'
             AND notification_target_json IS NOT NULL
             AND (
               (notification_state = 'pending' AND notification_next_at <= ?)
               OR (notification_state = 'running' AND updated_at <= ?)
             )
           ORDER BY completed_at LIMIT ?`,
        )
        .all(now, staleBefore, limit) as JobRow[]
    ).map(toJob);
  }

  markNotificationRunning(id: string): void {
    this.db
      .prepare(
        `UPDATE media_upgrade_check_jobs
         SET notification_state = 'running', updated_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
  }

  markNotificationSent(id: string): void {
    this.db
      .prepare(
        `UPDATE media_upgrade_check_jobs
         SET notification_state = 'sent', notification_error = '',
             updated_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
  }

  markNotificationFailed(
    id: string,
    attempts: number,
    error: string,
    nextAttemptAt?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE media_upgrade_check_jobs
         SET notification_state = ?, notification_attempts = ?,
             notification_next_at = ?, notification_error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        nextAttemptAt ? "pending" : "failed",
        attempts,
        nextAttemptAt ?? null,
        error.slice(0, 1_000),
        new Date().toISOString(),
        id,
      );
  }

  private item(id: string): UpgradeCheckItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM media_upgrade_check_items WHERE id = ?")
      .get(id) as ItemRow | undefined;
    return row ? toItem(row) : undefined;
  }

  private counts(jobId: string): Omit<
    UpgradeCheckSummary,
    | "jobId"
    | "state"
    | "targetResolution"
    | "createdAt"
    | "updatedAt"
    | "completedAt"
  > {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS total FROM media_upgrade_check_items
         WHERE job_id = ? GROUP BY state`,
      )
      .all(jobId) as Array<{ state: UpgradeCheckItemState; total: number }>;
    const counts = Object.fromEntries(rows.map((row) => [row.state, row.total]));
    const value = (state: UpgradeCheckItemState) => Number(counts[state] ?? 0);
    return {
      total: rows.reduce((sum, row) => sum + row.total, 0),
      checked: value("matched") + value("no_match") + value("failed"),
      matched: value("matched"),
      noMatch: value("no_match"),
      failed: value("failed"),
      pending: value("pending"),
      running: value("running"),
    };
  }

  private finalizeIfComplete(jobId: string, now: string): void {
    const remaining = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS total FROM media_upgrade_check_items
           WHERE job_id = ? AND state IN ('pending', 'running')`,
        )
        .get(jobId) as { total: number }
    ).total;
    if (remaining > 0) {
      this.db
        .prepare(
          "UPDATE media_upgrade_check_jobs SET updated_at = ? WHERE id = ?",
        )
        .run(now, jobId);
      return;
    }
    const job = this.job(jobId);
    this.db
      .prepare(
        `UPDATE media_upgrade_check_jobs
         SET state = 'completed', completed_at = ?, updated_at = ?,
             notification_state = ?, notification_next_at = ?
         WHERE id = ?`,
      )
      .run(
        now,
        now,
        job?.notificationTarget ? "pending" : "none",
        job?.notificationTarget ? now : null,
        jobId,
      );
  }
}

function buildQuery(target: {
  title: string;
  originalTitle?: string;
  productionYear?: number;
}): string {
  return [target.originalTitle || target.title, target.productionYear]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function toJob(row: JobRow): UpgradeCheckJob {
  return {
    id: row.id,
    userId: row.user_id,
    targetResolution: row.target_resolution,
    state: row.state,
    notificationTarget: row.notification_target_json
      ? (JSON.parse(
          row.notification_target_json,
        ) as UpgradeCheckNotificationTarget)
      : undefined,
    notificationState: row.notification_state,
    notificationAttempts: row.notification_attempts,
    notificationNextAt: row.notification_next_at ?? undefined,
    notificationError: row.notification_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function toItem(row: ItemRow): UpgradeCheckItem {
  return {
    id: row.id,
    jobId: row.job_id,
    jellyfinItemId: row.jellyfin_item_id,
    title: row.title,
    originalTitle: row.original_title,
    productionYear: row.production_year ?? undefined,
    currentResolution: row.current_resolution,
    query: row.query,
    state: row.state,
    candidateCount: row.candidate_count,
    candidates: JSON.parse(row.candidates_json) as UpgradeCheckCandidate[],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
