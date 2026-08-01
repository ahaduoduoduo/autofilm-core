import type { TaskSummary } from "@autofilm/contracts";
import type { AgentService } from "../agent/service.js";
import { agentMessages } from "../channels/agent-messages.js";
import type {
  MediaUpgradeItem,
  MediaUpgradeStore,
} from "../db/media-upgrade-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { TaskStore } from "../db/task-store.js";
import {
  parseCompletionContinuation,
  type CompletionContinuation,
} from "./completion-continuation.js";

interface NotificationTarget {
  channel: string;
  providerInstanceId: string;
  targetId: string;
}

const RUNNING_STALE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

export class DownloadCompletionWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly tasks: TaskStore,
    private readonly agent: AgentService,
    private readonly outbox: OutboxStore,
    private readonly mediaBaseUrl: string,
    private readonly mediaUpgrades?: MediaUpgradeStore,
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
      const groups = completionGroups(this.tasks.list(500));
      for (const group of groups) {
        if (!this.ready(group) || !due(group)) continue;
        await this.complete(group).catch(() => undefined);
      }
    } finally {
      this.running = false;
    }
  }

  private ready(group: TaskSummary[]): boolean {
    return group.every((task) => {
      const upgrade = mediaUpgradeReference(task.metadata.mediaUpgrade);
      if (upgrade) {
        const item = this.mediaUpgrades?.get(upgrade.upgradeItemId);
        return Boolean(
          item &&
            ["succeeded", "succeeded_with_backup_error", "failed"].includes(
              item.state,
            ) &&
            ["completed", "failed", "cancelled"].includes(task.state),
        );
      }
      if (task.state !== "completed") return false;
      const refresh = task.metadata.jellyfinRefresh;
      return Boolean(
        refresh &&
          typeof refresh === "object" &&
          !Array.isArray(refresh) &&
          (refresh as Record<string, unknown>).state === "completed",
      );
    });
  }

  private async complete(group: TaskSummary[]): Promise<void> {
    const leader = group[0]!;
    const continuation = parseCompletionContinuation(
      leader.metadata.completionContinuation,
    )!;
    const target = notificationTarget(leader.metadata.notificationTarget);
    if (!leader.userId || !target) {
      this.updateGroup(group, {
        ...continuation,
        state: "completed",
        completedAt: new Date().toISOString(),
        error: undefined,
      });
      return;
    }

    const startedAt = new Date().toISOString();
    this.updateGroup(group, {
      ...continuation,
      state: "running",
      startedAt,
      error: undefined,
    });
    try {
      const content = await this.agent.respond({
        userId: leader.userId,
        channel: target.channel,
        providerInstanceId: target.providerInstanceId,
        externalConversationId: target.targetId,
        text: completionEvent(
          group,
          continuation.workflowId,
          this.mediaUpgrades,
        ),
      });
      this.outbox.enqueueMessages({
        userId: leader.userId,
        ...target,
        messages: agentMessages(content, this.mediaBaseUrl),
      });
      this.updateGroup(group, {
        ...continuation,
        state: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        error: undefined,
      });
    } catch (error) {
      this.deferOrFail(group, continuation, error);
    }
  }

  private deferOrFail(
    group: TaskSummary[],
    current: CompletionContinuation,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = current.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.updateGroup(group, {
        ...current,
        state: "failed",
        attempts,
        error: message.slice(0, 1000),
      });
      const leader = group[0]!;
      const target = notificationTarget(leader.metadata.notificationTarget);
      if (leader.userId && target) {
        this.outbox.enqueue({
          userId: leader.userId,
          ...target,
          text:
            `${completionFailurePrefix(group)}，但 Agent 后续处理失败：${message}\n` +
            "字幕尚未完成时，可在当前对话中继续处理。",
        });
      }
      return;
    }
    const delayMs = Math.min(5 * 60_000, 2 ** attempts * 15_000);
    this.updateGroup(group, {
      ...current,
      state: "pending",
      attempts,
      nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
      error: message.slice(0, 1000),
    });
  }

  private updateGroup(
    group: TaskSummary[],
    continuation: CompletionContinuation,
  ): void {
    for (const task of group) {
      this.tasks.update(task.id, {
        metadata: {
          ...task.metadata,
          completionContinuation: continuation,
        },
      });
    }
  }
}

function completionGroups(tasks: TaskSummary[]): TaskSummary[][] {
  const groups = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    const continuation = parseCompletionContinuation(
      task.metadata.completionContinuation,
    );
    if (!continuation || continuation.state === "completed") continue;
    const group = groups.get(continuation.workflowId) ?? [];
    group.push(task);
    groups.set(continuation.workflowId, group);
  }
  return [...groups.values()].map((group) =>
    group.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
  );
}

function due(group: TaskSummary[]): boolean {
  const continuation = parseCompletionContinuation(
    group[0]!.metadata.completionContinuation,
  );
  if (!continuation || continuation.state === "failed") return false;
  if (continuation.state === "running") {
    const startedAt = Date.parse(continuation.startedAt ?? "");
    return !Number.isFinite(startedAt) ||
      Date.now() - startedAt >= RUNNING_STALE_MS;
  }
  return Date.parse(continuation.nextAttemptAt) <= Date.now();
}

function notificationTarget(value: unknown): NotificationTarget | undefined {
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

function completionEvent(
  group: TaskSummary[],
  workflowId: string,
  mediaUpgrades?: MediaUpgradeStore,
): string {
  const upgradeItems = group
    .map((task) => {
      const reference = mediaUpgradeReference(task.metadata.mediaUpgrade);
      return reference ? mediaUpgrades?.get(reference.upgradeItemId) : undefined;
    })
    .filter((item): item is MediaUpgradeItem => Boolean(item));
  if (upgradeItems.length === group.length) {
    return mediaUpgradeCompletionEvent(upgradeItems, workflowId);
  }
  const tasks = group
    .map((task) => {
      const refresh = task.metadata.jellyfinRefresh as
        | Record<string, unknown>
        | undefined;
      return `- ${task.title}\n  Jellyfin 刷新路径：${String(refresh?.path ?? "")}`;
    })
    .join("\n");
  return (
    "【AutoFilm 后台事件】\n" +
    "这不是用户的新下载指令。此前已经获得同意的下载现已成功，并且 Jellyfin 已完成入库。\n" +
    `工作流 ID：${workflowId}\n${tasks}\n` +
    "继续当前对话中已经约定但尚未执行的后续操作。若此前已经下载了用户认可的字幕，" +
    "现在定位对应的 Jellyfin Movie/Episode，并按标准字幕流程完成映射和放置。" +
    "若视频已有合适内封字幕、用户不需要字幕、没有满意字幕或此前没有字幕计划，" +
    "不要新增字幕，直接报告视频已经入库。不得重新搜索或下载视频资源。" +
    "最终回复分别说明视频入库结果和实际执行的字幕结果。"
  );
}

function mediaUpgradeCompletionEvent(
  items: MediaUpgradeItem[],
  workflowId: string,
): string {
  const failed = items.filter((item) => item.state === "failed");
  const details = items
    .map((item) => {
      const lines = [
        `- ${item.title}`,
        `  升级项目 ID：${item.id}`,
        `  Jellyfin Item ID：${item.jellyfinItemId}`,
        `  状态：${item.state}`,
      ];
      if (item.newPath) lines.push(`  新文件：${item.newPath}`);
      if (item.backupPath) lines.push(`  旧文件备份：${item.backupPath}`);
      if (item.error) lines.push(`  说明：${item.error}`);
      return lines.join("\n");
    })
    .join("\n");
  if (failed.length > 0) {
    return (
      "【AutoFilm 后台事件】\n" +
      "这不是用户的新升级指令。此前已经获得同意的媒体升级现已结束，但升级失败。\n" +
      `工作流 ID：${workflowId}\n${details}\n` +
      "向用户报告具体失败结果。不得把下载提交或临时文件误报为升级成功，也不要执行仅在" +
      "新版本启用后才适用的字幕放置。保留当前对话中仍然有效的信息，等待用户决定是否重新选择资源。"
    );
  }
  return (
    "【AutoFilm 后台事件】\n" +
    "这不是用户的新升级指令。此前已经获得同意的媒体升级现已完成，Jellyfin 原条目已经指向新文件。\n" +
    `工作流 ID：${workflowId}\n${details}\n` +
    "继续当前对话中已经约定但尚未执行的后续操作。若此前已经确定或用户明确要求了字幕，" +
    "现在使用原 Jellyfin Item ID 完成字幕处理和放置；若没有字幕计划、没有满意字幕或视频已有" +
    "合适字幕，不要新增字幕。不得重新搜索或下载视频资源。最终回复分别说明资源升级结果和" +
    "实际执行的字幕结果。状态为 succeeded_with_backup_error 时还要说明旧文件备份未完成。"
  );
}

function mediaUpgradeReference(
  value: unknown,
): { upgradeItemId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const reference = value as Record<string, unknown>;
  return typeof reference.upgradeItemId === "string"
    ? { upgradeItemId: reference.upgradeItemId }
    : undefined;
}

function completionFailurePrefix(group: TaskSummary[]): string {
  return group.some((task) => mediaUpgradeReference(task.metadata.mediaUpgrade))
    ? "资源升级状态已经写入"
    : "视频已经加入 Jellyfin";
}
