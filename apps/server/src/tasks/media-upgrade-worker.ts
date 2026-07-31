import path from "node:path";
import type {
  MediaUpgradeItem,
  MediaUpgradeStore,
} from "../db/media-upgrade-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { TaskStore } from "../db/task-store.js";
import type { JellyfinClient } from "../integrations/jellyfin.js";
import type { OpenListClient } from "../integrations/openlist.js";
import {
  effectiveOriginalOpenListPath,
  hasVideoStream,
  moveOpenListObjectIdempotently,
  openListPathFromUri,
  resolveOriginalOpenListPath,
  toOpenListUri,
} from "./media-upgrade-files.js";

const PROCESS_CONCURRENCY = 4;

export class MediaUpgradeWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly upgrades: MediaUpgradeStore,
    private readonly tasks: TaskStore,
    private readonly openList: OpenListClient,
    private readonly jellyfin: JellyfinClient,
    private readonly outbox: OutboxStore,
    private readonly intervalMs = 5_000,
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
      const items = this.upgrades.dueForProcessing();
      await mapConcurrent(items, PROCESS_CONCURRENCY, async (item) => {
        await this.process(item).catch((error) => this.fail(item, error));
      });
    } finally {
      this.running = false;
    }
  }

  private async process(item: MediaUpgradeItem): Promise<void> {
    if (item.state === "downloading") {
      const download = item.downloadTaskId
        ? this.tasks.get(item.downloadTaskId)
        : undefined;
      if (!download) {
        throw new Error("升级下载任务不存在");
      }
      if (download.state === "waiting") {
        this.upgrades.update(item.id, {
          state: "awaiting_alternative",
          error: download.statusText || "正在等待用户选择备用资源",
        });
        return;
      }
      if (["failed", "cancelled"].includes(download.state)) {
        throw new Error(download.statusText || `下载状态为 ${download.state}`);
      }
      if (download.state !== "completed") return;
      const resultPath = String(download.metadata.remoteResultPath ?? "");
      if (!resultPath.startsWith("/")) {
        throw new Error("OpenList成功任务没有返回结果路径");
      }
      item = this.upgrades.update(item.id, {
        state: "inspecting",
        error: "",
      });
    }

    const download = item.downloadTaskId
      ? this.tasks.get(item.downloadTaskId)
      : undefined;
    const resultPath = String(download?.metadata.remoteResultPath ?? "");
    if (!item.newPath) {
      const recordedOriginalPath = openListPathFromUri(item.current.path);
      const currentOriginalPath = effectiveOriginalOpenListPath(item.current);
      const resolvedOriginalPath = await resolveOriginalOpenListPath(
        this.openList,
        {
          recordedPath: currentOriginalPath,
          expectedSize: currentMediaSize(item.current),
        },
      );
      if (
        resolvedOriginalPath !== recordedOriginalPath &&
        item.current.resolvedOriginalPath !== resolvedOriginalPath
      ) {
        item = this.upgrades.update(item.id, {
          current: {
            ...item.current,
            resolvedOriginalPath,
          },
          error: "",
        });
      }
      const selectedPath = await this.selectDownloadedVideo(item, resultPath);
      const destinationDirectory = path.posix.dirname(resolvedOriginalPath);
      const destinationName = uniqueUpgradeName(
        path.posix.basename(selectedPath),
        item.id,
      );
      const moved = await moveOpenListObjectIdempotently(this.openList, {
        sourcePath: selectedPath,
        destinationDirectory,
        destinationName,
      });
      item = this.upgrades.update(item.id, {
        state: "activating",
        newPath: moved.path,
        error: "",
      });
    }

    const current = await this.jellyfin.item(item.jellyfinItemId);
    const expectedUri = toOpenListUri(item.newPath!);
    let rollbackToken = item.rollbackToken;
    if (current.Path !== expectedUri) {
      const preview = await this.jellyfin.previewReplacement(
        item.jellyfinItemId,
        item.newPath!,
        typeof item.current.resolvedOriginalPath === "string"
          ? item.current.resolvedOriginalPath
          : undefined,
      );
      rejectResolutionRegression(preview.current, preview.replacement);
      let applied: Record<string, unknown> | undefined;
      try {
        applied = await this.jellyfin.applyReplacement(preview.previewToken);
      } catch (error) {
        const afterError = await this.jellyfin.item(item.jellyfinItemId);
        if (afterError.Path !== expectedUri || !hasVideoStream(afterError)) {
          throw error;
        }
      }
      rollbackToken = applied
        ? optionalStringField(applied, "rollbackToken", "RollbackToken")
        : undefined;
      item = this.upgrades.update(item.id, {
        rollbackToken: rollbackToken ?? null,
      });
    }

    const verified = await this.jellyfin.item(item.jellyfinItemId);
    if (
      verified.Id !== item.jellyfinItemId ||
      verified.Path !== expectedUri ||
      !hasVideoStream(verified)
    ) {
      if (rollbackToken) {
        await this.jellyfin.rollbackReplacement(rollbackToken);
      }
      throw new Error("Jellyfin自动验证没有返回新的媒体路径和视频流");
    }

    this.upgrades.update(item.id, {
      state: "succeeded",
      error: "",
    });
    let backupPath: string | undefined;
    let archiveError = "";
    try {
      const backupDirectory = `/115/autofilm-backups/upgrades/${item.id}`;
      await this.openList.mkdir(backupDirectory);
      const oldPath = effectiveOriginalOpenListPath(item.current);
      const moved = await moveOpenListObjectIdempotently(this.openList, {
        sourcePath: oldPath,
        destinationDirectory: backupDirectory,
      });
      backupPath = moved.path;
      this.upgrades.update(item.id, {
        backupPath,
        error: "",
      });
    } catch (error) {
      archiveError = error instanceof Error ? error.message : String(error);
      this.upgrades.update(item.id, {
        state: "succeeded_with_backup_error",
        error: `新版本已启用；旧文件移动失败：${archiveError}`,
      });
    }
    await this.deleteStagingDirectory(item).catch(() => undefined);
    this.notify(
      item,
      `资源升级成功：${item.title}\n` +
        `Jellyfin 条目 ID 保持不变：${item.jellyfinItemId}\n` +
        `新文件：${item.newPath}\n` +
        (backupPath
          ? `旧文件备份：${backupPath}`
          : `旧文件尚未移出媒体目录：${archiveError}`),
    );
  }

  private async selectDownloadedVideo(
    item: MediaUpgradeItem,
    resultPath: string,
  ): Promise<string> {
    const inspected = await this.jellyfin.inspectReplacement(resultPath);
    const candidates = inspected.candidates.filter(
      (candidate) => !candidate.extraType,
    );
    const targetSeason = numberValue(item.current.season);
    const targetEpisode = numberValue(item.current.episode);
    const matching =
      item.current.type === "Episode"
        ? candidates.filter(
            (candidate) =>
              candidate.seasonNumber === targetSeason &&
              candidate.episodeNumber === targetEpisode,
          )
        : candidates;
    const selected = [...matching].sort(
      (left, right) => right.size - left.size,
    )[0];
    if (!selected) {
      throw new Error(
        item.current.type === "Episode"
          ? "下载结果中没有识别到对应季集的视频"
          : "下载结果中没有识别到主视频",
      );
    }
    return selected.path;
  }

  private async deleteStagingDirectory(item: MediaUpgradeItem): Promise<void> {
    const download = item.downloadTaskId
      ? this.tasks.get(item.downloadTaskId)
      : undefined;
    const destination = String(download?.metadata.destination ?? "");
    if (destination === `/115/autofilm-staging/upgrades/${item.id}`) {
      await this.openList.deleteObject(destination);
    }
  }

  private async fail(item: MediaUpgradeItem, error: unknown): Promise<void> {
    let message = error instanceof Error ? error.message : String(error);
    const current = this.upgrades.get(item.id);
    if (!current) return;
    if (current.state === "succeeded") {
      this.upgrades.update(current.id, {
        state: "succeeded_with_backup_error",
        error: `新版本已启用；旧文件归档未完成：${message}`.slice(0, 1000),
      });
      this.notify(
        current,
        `资源升级已启用，但旧文件归档未完成：${current.title}\n${message}`,
      );
      return;
    }
    if (current.state === "activating" && current.newPath) {
      try {
        const jellyfinItem = await this.jellyfin.item(current.jellyfinItemId);
        const expectedUri = toOpenListUri(current.newPath);
        if (
          jellyfinItem.Path === expectedUri &&
          hasVideoStream(jellyfinItem)
        ) {
          await this.process(current);
          return;
        }
        const effectiveOriginalUri = toOpenListUri(
          effectiveOriginalOpenListPath(current.current),
        );
        if (
          jellyfinItem.Path === String(current.current.path ?? "") ||
          jellyfinItem.Path === effectiveOriginalUri
        ) {
          const download = current.downloadTaskId
            ? this.tasks.get(current.downloadTaskId)
            : undefined;
          const destination = String(download?.metadata.destination ?? "");
          if (destination.startsWith("/")) {
            await moveOpenListObjectIdempotently(this.openList, {
              sourcePath: current.newPath,
              destinationDirectory: destination,
            });
            this.upgrades.update(current.id, { newPath: null });
          }
        }
      } catch (cleanupError) {
        message +=
          `；失败后的文件状态检查未完成：` +
          (cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError));
      }
    }
    this.upgrades.update(current.id, {
      state: "failed",
      error: message.slice(0, 1000),
    });
    this.notify(current, `资源升级失败：${current.title}\n${message}`);
  }

  private notify(item: MediaUpgradeItem, text: string): void {
    const download = item.downloadTaskId
      ? this.tasks.get(item.downloadTaskId)
      : undefined;
    const target = notificationTarget(download?.metadata.notificationTarget);
    this.outbox.enqueue({
      userId: download?.userId,
      channel: target?.channel,
      providerInstanceId: target?.providerInstanceId,
      targetId: target?.targetId,
      text,
    });
  }
}

function uniqueUpgradeName(name: string, id: string): string {
  const extension = path.posix.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  return `${stem}.upgrade-${id.slice(0, 8)}${extension}`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function currentMediaSize(
  current: Record<string, unknown>,
): number | undefined {
  const sources = current.mediaSources;
  if (!Array.isArray(sources)) return undefined;
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      continue;
    }
    const size = Number((source as Record<string, unknown>).Size);
    if (Number.isFinite(size) && size > 0) return size;
  }
  return undefined;
}

function rejectResolutionRegression(
  current: { width?: number; height?: number },
  replacement: { width?: number; height?: number },
): void {
  const currentPixels = resolutionPixels(current);
  const replacementPixels = resolutionPixels(replacement);
  if (replacementPixels === 0) {
    throw new Error("新文件探测结果缺少有效视频分辨率");
  }
  if (currentPixels > 0 && replacementPixels < currentPixels) {
    throw new Error(
      `新文件分辨率 ${replacement.width}x${replacement.height} 低于原文件 ` +
        `${current.width}x${current.height}，已拒绝替换`,
    );
  }
}

function resolutionPixels(value: {
  width?: number;
  height?: number;
}): number {
  return (value.width ?? 0) * (value.height ?? 0);
}

function optionalStringField(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) {
      return value[key] as string;
    }
  }
  return undefined;
}

function notificationTarget(value: unknown):
  | { channel: string; providerInstanceId: string; targetId: string }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const target = value as Record<string, unknown>;
  return typeof target.channel === "string" &&
    typeof target.providerInstanceId === "string" &&
    typeof target.targetId === "string"
    ? {
        channel: target.channel,
        providerInstanceId: target.providerInstanceId,
        targetId: target.targetId,
      }
    : undefined;
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  execute: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      await execute(values[index]!);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
}
