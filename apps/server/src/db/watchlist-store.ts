import { randomUUID } from "node:crypto";
import type { WatchlistSummary } from "@autofilm/contracts";
import type { AppDatabase } from "./database.js";

export interface WatchlistEpisode {
  episodeNumber: number;
  airDate: string;
  status: "upcoming" | "aired" | "notified" | "downloaded";
  updatedAt: string;
}

export interface WatchlistEntry extends WatchlistSummary {
  notificationTarget?: {
    channel: string;
    providerInstanceId: string;
    targetId: string;
  };
  episodes: WatchlistEpisode[];
}

interface WatchlistRow {
  id: string;
  user_id: string;
  tmdb_id: number;
  title: string;
  original_title: string;
  season: number;
  total_episodes: number;
  conditions: string;
  destination: string;
  status: "active" | "completed" | "paused";
  channel: string | null;
  provider_instance_id: string | null;
  target_id: string | null;
  next_check_at: string;
  created_at: string;
  updated_at: string;
}

interface EpisodeRow {
  episode_number: number;
  air_date: string;
  status: WatchlistEpisode["status"];
  updated_at: string;
}

export class WatchlistStore {
  constructor(private readonly db: AppDatabase) {}

  add(input: {
    userId: string;
    tmdbId: number;
    title: string;
    originalTitle: string;
    season: number;
    conditions: string;
    destination: string;
    episodes: Array<{ episodeNumber: number; airDate: string }>;
    notificationTarget?: {
      channel: string;
      providerInstanceId: string;
      targetId: string;
    };
  }): WatchlistEntry {
    const existing = this.db
      .prepare(
        "SELECT id FROM watchlists WHERE user_id = ? AND tmdb_id = ? AND season = ?",
      )
      .get(input.userId, input.tmdbId, input.season) as
      | { id: string }
      | undefined;
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO watchlists
            (id, user_id, tmdb_id, title, original_title, season,
             total_episodes, conditions, destination, status, channel,
             provider_instance_id, target_id, next_check_at, created_at,
             updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title,
             original_title=excluded.original_title,
             total_episodes=excluded.total_episodes,
             conditions=excluded.conditions, destination=excluded.destination,
             status='active', channel=excluded.channel,
             provider_instance_id=excluded.provider_instance_id,
             target_id=excluded.target_id, next_check_at=excluded.next_check_at,
             updated_at=excluded.updated_at`,
        )
        .run(
          id,
          input.userId,
          input.tmdbId,
          input.title,
          input.originalTitle,
          input.season,
          input.episodes.length,
          input.conditions,
          input.destination,
          input.notificationTarget?.channel ?? null,
          input.notificationTarget?.providerInstanceId ?? null,
          input.notificationTarget?.targetId ?? null,
          now,
          now,
          now,
        );
      const episodeStatement = this.db.prepare(
        `INSERT INTO watchlist_episodes
          (watchlist_id, episode_number, air_date, status, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(watchlist_id, episode_number) DO UPDATE SET
           air_date=excluded.air_date, updated_at=excluded.updated_at`,
      );
      const today = chinaDate();
      for (const episode of input.episodes) {
        episodeStatement.run(
          id,
          episode.episodeNumber,
          episode.airDate,
          episode.airDate && episode.airDate <= today ? "aired" : "upcoming",
          now,
        );
      }
    })();
    return this.get(input.userId, id)!;
  }

  get(userId: string, id: string): WatchlistEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM watchlists WHERE id = ? AND user_id = ?")
      .get(id, userId) as WatchlistRow | undefined;
    return row ? this.toEntry(row) : undefined;
  }

  list(userId?: string): WatchlistEntry[] {
    const rows = (
      userId
        ? this.db
            .prepare(
              "SELECT * FROM watchlists WHERE user_id = ? ORDER BY created_at DESC",
            )
            .all(userId)
        : this.db
            .prepare("SELECT * FROM watchlists ORDER BY created_at DESC")
            .all()
    ) as WatchlistRow[];
    return rows.map((row) => this.toEntry(row));
  }

  due(limit = 20): WatchlistEntry[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM watchlists
           WHERE status = 'active' AND next_check_at <= ?
           ORDER BY next_check_at LIMIT ?`,
        )
        .all(new Date().toISOString(), limit) as WatchlistRow[]
    ).map((row) => this.toEntry(row));
  }

  remove(userId: string, id: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM watchlists WHERE id = ? AND user_id = ?")
        .run(id, userId).changes > 0
    );
  }

  updateEpisodes(
    id: string,
    episodes: Array<{ episodeNumber: number; airDate: string }>,
    nextCheckAt: Date,
  ): WatchlistEntry | undefined {
    const now = new Date().toISOString();
    const today = chinaDate();
    this.db.transaction(() => {
      const statement = this.db.prepare(
        `INSERT INTO watchlist_episodes
          (watchlist_id, episode_number, air_date, status, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(watchlist_id, episode_number) DO UPDATE SET
           air_date=excluded.air_date,
           status=CASE
             WHEN watchlist_episodes.status IN ('downloaded','notified')
               THEN watchlist_episodes.status
             ELSE excluded.status
           END,
           updated_at=excluded.updated_at`,
      );
      for (const episode of episodes) {
        statement.run(
          id,
          episode.episodeNumber,
          episode.airDate,
          episode.airDate && episode.airDate <= today ? "aired" : "upcoming",
          now,
        );
      }
      this.db
        .prepare(
          `UPDATE watchlists SET total_episodes = ?, next_check_at = ?,
           updated_at = ? WHERE id = ?`,
        )
        .run(episodes.length, nextCheckAt.toISOString(), now, id);
    })();
    const row = this.db.prepare("SELECT user_id FROM watchlists WHERE id = ?").get(
      id,
    ) as { user_id: string } | undefined;
    return row ? this.get(row.user_id, id) : undefined;
  }

  markNotified(id: string, episodeNumbers: number[]): void {
    const statement = this.db.prepare(
      `UPDATE watchlist_episodes SET status='notified', updated_at=?
       WHERE watchlist_id=? AND episode_number=? AND status='aired'`,
    );
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const episode of episodeNumbers) statement.run(now, id, episode);
    })();
  }

  private toEntry(row: WatchlistRow): WatchlistEntry {
    const episodes = (
      this.db
        .prepare(
          `SELECT * FROM watchlist_episodes
           WHERE watchlist_id = ? ORDER BY episode_number`,
        )
        .all(row.id) as EpisodeRow[]
    ).map((episode) => ({
      episodeNumber: episode.episode_number,
      airDate: episode.air_date,
      status: episode.status,
      updatedAt: episode.updated_at,
    }));
    return {
      id: row.id,
      userId: row.user_id,
      tmdbId: row.tmdb_id,
      title: row.title,
      originalTitle: row.original_title,
      season: row.season,
      totalEpisodes: row.total_episodes,
      conditions: row.conditions,
      destination: row.destination,
      status: row.status,
      nextCheckAt: row.next_check_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      notificationTarget:
        row.channel && row.provider_instance_id && row.target_id
          ? {
              channel: row.channel,
              providerInstanceId: row.provider_instance_id,
              targetId: row.target_id,
            }
          : undefined,
      episodes,
    };
  }
}

function chinaDate(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
}
