import type { AgentService } from "../agent/service.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { WatchlistStore } from "../db/watchlist-store.js";
import type { TmdbClient } from "../integrations/tmdb.js";

export class WatchlistWorker {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly watchlists: WatchlistStore,
    private readonly tmdb: TmdbClient,
    private readonly agent: AgentService,
    private readonly outbox: OutboxStore,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const entry of this.watchlists.due(20)) {
        await this.check(entry.id, entry.userId).catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }

  private async check(id: string, userId: string): Promise<void> {
    const entry = this.watchlists.get(userId, id);
    if (!entry) return;
    const season = await this.tmdb.season(entry.tmdbId, entry.season);
    const updated = this.watchlists.updateEpisodes(
      entry.id,
      season.episodes.map((episode) => ({
        episodeNumber: episode.episodeNumber,
        airDate: episode.airDate,
      })),
      new Date(Date.now() + this.intervalMs),
    );
    if (!updated) return;
    const aired = updated.episodes
      .filter((episode) => episode.status === "aired")
      .map((episode) => episode.episodeNumber);
    if (aired.length === 0) return;
    const evaluation = await this.agent.evaluateWatchlist({
      userId: updated.userId,
      title: updated.title,
      originalTitle: updated.originalTitle,
      season: updated.season,
      episodeNumbers: aired,
      conditions: updated.conditions,
    });
    if (!evaluation.trimStart().startsWith("[MATCH]")) return;
    this.outbox.enqueue({
      userId: updated.userId,
      channel: updated.notificationTarget?.channel,
      providerInstanceId: updated.notificationTarget?.providerInstanceId,
      targetId: updated.notificationTarget?.targetId,
      text:
        `追更条件已满足：${updated.title} ` +
        `S${String(updated.season).padStart(2, "0")} ` +
        `${aired.map((value) => `E${String(value).padStart(2, "0")}`).join(", ")}\n` +
        evaluation.replace(/^\s*\[MATCH]\s*/i, ""),
    });
    this.watchlists.markNotified(updated.id, aired);
  }
}
