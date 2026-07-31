import type { AgentService } from "../agent/service.js";
import { agentMessages } from "../channels/agent-messages.js";
import type {
  MediaUpgradeCheckStore,
  UpgradeCheckCandidate,
  UpgradeCheckItem,
  UpgradeCheckJob,
  UpgradeCheckResolution,
} from "../db/media-upgrade-check-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { JackettClient, JackettRelease } from "../integrations/jackett.js";

const SEARCH_CONCURRENCY = 8;
const RUNNING_STALE_MS = 10 * 60_000;
const MAX_NOTIFICATION_ATTEMPTS = 3;
const MAX_STORED_CANDIDATES = 20;

export class MediaUpgradeCheckWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly checks: MediaUpgradeCheckStore,
    private readonly jackett: JackettClient,
    private readonly agent: AgentService,
    private readonly outbox: OutboxStore,
    private readonly mediaBaseUrl: string,
    private readonly intervalMs = 2_000,
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
      const staleBefore = new Date(Date.now() - RUNNING_STALE_MS).toISOString();
      const items = this.checks.claim(SEARCH_CONCURRENCY, staleBefore);
      await Promise.all(items.map((item) => this.check(item)));
      for (const job of this.checks.dueNotifications(staleBefore)) {
        await this.notify(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async check(item: UpgradeCheckItem): Promise<void> {
    try {
      const releases = await withSingleRetry(() =>
        this.jackett.searchAll(item.query),
      );
      const job = this.checks.job(item.jobId);
      if (!job) return;
      const matches = releases.filter((release) =>
        hasResolution(release.title, job.targetResolution),
      );
      this.checks.completeItem({
        id: item.id,
        state: matches.length > 0 ? "matched" : "no_match",
        candidateCount: matches.length,
        candidates: matches
          .slice(0, MAX_STORED_CANDIDATES)
          .map(candidateSummary),
      });
    } catch (error) {
      this.checks.completeItem({
        id: item.id,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async notify(job: UpgradeCheckJob): Promise<void> {
    const target = job.notificationTarget;
    if (!target) return;
    this.checks.markNotificationRunning(job.id);
    try {
      const content = await this.agent.respond({
        userId: job.userId,
        channel: target.channel,
        providerInstanceId: target.providerInstanceId,
        externalConversationId: target.targetId,
        text: completionEvent(this.checks, job),
      });
      this.outbox.enqueueMessages({
        userId: job.userId,
        ...target,
        messages: agentMessages(content, this.mediaBaseUrl),
      });
      this.checks.markNotificationSent(job.id);
    } catch (error) {
      const attempts = job.notificationAttempts + 1;
      const nextAttemptAt =
        attempts < MAX_NOTIFICATION_ATTEMPTS
          ? new Date(Date.now() + attempts * 30_000).toISOString()
          : undefined;
      this.checks.markNotificationFailed(
        job.id,
        attempts,
        error instanceof Error ? error.message : String(error),
        nextAttemptAt,
      );
    }
  }
}

export function hasResolution(
  title: string,
  resolution: UpgradeCheckResolution,
): boolean {
  const tokens = title
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (resolution === "2160p") {
    return tokens.some((token) => ["2160p", "4k", "uhd"].includes(token));
  }
  if (resolution === "4320p") {
    return tokens.some((token) => ["4320p", "8k"].includes(token));
  }
  return tokens.some((token) => ["1080p", "1080i"].includes(token));
}

function candidateSummary(release: JackettRelease): UpgradeCheckCandidate {
  return {
    title:
      release.title.length > 400
        ? `${release.title.slice(0, 400)}…`
        : release.title,
    size: release.size,
    seeders: release.seeders,
    peers: release.peers,
    tracker: release.tracker,
    publishDate: release.publishDate,
  };
}

async function withSingleRetry<T>(execute: () => Promise<T>): Promise<T> {
  try {
    return await execute();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return execute();
  }
}

function completionEvent(
  checks: MediaUpgradeCheckStore,
  job: UpgradeCheckJob,
): string {
  const summary = checks.summary(job.id)!;
  return (
    "【AutoFilm 后台事件】\n" +
    "这不是用户的新搜索指令。此前提交的批量画质升级检查已经完成。\n" +
    `任务 ID：${job.id}\n` +
    `目标分辨率：${job.targetResolution}\n` +
    `统计：总数 ${summary.total}，命中 ${summary.matched}，无结果 ${summary.noMatch}，查询失败 ${summary.failed}。\n` +
    "立即调用 get_bulk_media_upgrade_check_results 读取 page=0、limit=10。" +
    "只向用户整理命中项和前三个样例资源，不列举无结果的片名。" +
    "若有更多结果，说明任务 ID、总命中数和下一页页码，让用户按页查看或指定片名。" +
    "这只是只读检查；未经用户选择和确认，不得开始资源升级。"
  );
}
