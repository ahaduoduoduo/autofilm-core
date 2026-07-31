import type { TaskStore } from "../db/task-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import {
  OPENLIST_TASK_STATE,
  type OpenListTask,
} from "../integrations/openlist.js";
import type { TaskSummary } from "@autofilm/contracts";
import {
  taskDownloadCandidates,
  type StoredDownloadCandidate,
} from "./download-candidates.js";

interface OpenListTaskSource {
  listOfflineTasks(): Promise<OpenListTask[]>;
  deleteOfflineTask(taskId: string): Promise<void>;
}

interface JellyfinRefreshTarget {
  remoteRefresh(input: {
    path: string;
    recursive?: boolean;
    refresh?: boolean;
    forceProbe?: boolean;
    providerIds?: Record<string, string>;
    providerTarget?: "movie";
  }): Promise<void>;
}

interface JellyfinRefreshState {
  state: "pending" | "completed";
  path: string;
  attempts: number;
  nextAttemptAt: string;
  completedAt?: string;
  error?: string;
  providerIds?: Record<string, string>;
  providerTarget?: "movie";
}

export class ProgressWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly openList: OpenListTaskSource,
    private readonly tasks: TaskStore,
    private readonly intervalMs = 15_000,
    private readonly outbox?: OutboxStore,
    private readonly jellyfin?: JellyfinRefreshTarget,
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
      try {
        const remoteTasks = await this.openList.listOfflineTasks();
        const remoteIds = new Set(remoteTasks.map((task) => task.id));
        for (const remote of remoteTasks) await this.updateFromRemote(remote);
        for (const local of this.tasks
          .list(500)
          .filter(
            (task) =>
              task.type === "offline-download" &&
              ["queued", "running", "waiting"].includes(task.state) &&
              task.metadata.awaitingFallbackSelection !== true &&
              (!task.externalId || !remoteIds.has(task.externalId)),
          )) {
          if (this.isExpired(local)) {
            await this.awaitFallbackSelection(
              local,
              "OpenList 中未找到仍在执行的任务",
            );
          }
        }
      } catch (error) {
        console.error(
          `OpenList task status request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.refreshCompletedDestinations();
    } finally {
      this.running = false;
    }
  }

  private async updateFromRemote(remote: OpenListTask): Promise<void> {
    const local = this.tasks.byExternalId(remote.id);
    if (!local) return;
    if (["completed", "failed", "cancelled"].includes(local.state)) return;
    const state = inferState(remote);
    if (
      ["failed", "cancelled"].includes(state) &&
      this.hasInstantPolicy(local)
    ) {
      await this.awaitFallbackSelection(
        local,
        remote.error || remote.status || "115 离线任务失败",
      );
      return;
    }
    if (state === "running" && this.isExpired(local)) {
      await this.awaitFallbackSelection(local, this.timeoutMessage(local));
      return;
    }
    const completedNow =
      local.state !== "completed" &&
      state === "completed";
    const updated = this.tasks.update(local.id, {
      state,
      progress: Number.isFinite(remote.progress)
        ? Math.max(0, Math.min(100, remote.progress))
        : null,
      statusText: remote.error || remote.status || state,
      metadata: {
        ...local.metadata,
        remoteName: remote.name,
        remoteResultPath: remote.result_path,
        totalBytes: remote.total_bytes,
        ...(completedNow
          ? this.initialJellyfinRefresh(local, remote.result_path)
          : {}),
      },
    });
    if (
      !["completed", "failed", "cancelled"].includes(local.state) &&
      ["completed", "failed", "cancelled"].includes(updated.state)
    ) {
      if (updated.state !== "completed") {
        this.outbox?.enqueueTaskResult(updated);
      }
    }
  }

  private initialJellyfinRefresh(
    task: TaskSummary,
    resultPath?: string,
  ): Record<string, unknown> {
    if (isRecord(task.metadata.mediaUpgrade)) {
      return {};
    }
    const destination = String(task.metadata.destination ?? "");
    const refreshPath = String(
      validResultPath(destination, resultPath)
        ? resultPath
        : task.metadata.jellyfinRefreshPath ?? destination,
    );
    if (!this.jellyfin || !refreshPath.startsWith("/")) return {};
    const providerIds = parseProviderIds(
      task.metadata.jellyfinProviderIds,
    );
    const providerTarget = taskMediaType(task) === "movie"
      ? "movie"
      : undefined;
    return {
      jellyfinRefresh: {
        state: "pending",
        path: refreshPath,
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
        providerIds,
        providerTarget,
      } satisfies JellyfinRefreshState,
    };
  }

  private async refreshCompletedDestinations(): Promise<void> {
    if (!this.jellyfin) return;
    const due = new Map<string, TaskSummary[]>();
    const now = Date.now();
    for (const task of this.tasks.list(500)) {
      if (task.state !== "completed") continue;
      const refresh = jellyfinRefreshState(task);
      if (
        !refresh ||
        refresh.state !== "pending" ||
        Date.parse(refresh.nextAttemptAt) > now
      ) {
        continue;
      }
      const tasks = due.get(refresh.path) ?? [];
      tasks.push(task);
      due.set(refresh.path, tasks);
    }

    for (const [path, tasks] of due) {
      try {
        const providerIds = jellyfinRefreshState(tasks[0]!)?.providerIds;
        const providerTarget = jellyfinRefreshState(
          tasks[0]!,
        )?.providerTarget;
        await this.jellyfin.remoteRefresh({
          path,
          recursive: true,
          refresh: true,
          forceProbe: false,
          ...(providerIds ? { providerIds } : {}),
          ...(providerTarget ? { providerTarget } : {}),
        });
        const completedAt = new Date().toISOString();
        for (const task of tasks) {
          const refresh = jellyfinRefreshState(task)!;
          this.tasks.update(task.id, {
            metadata: {
              ...task.metadata,
              jellyfinRefresh: {
                ...refresh,
                state: "completed",
                completedAt,
                error: undefined,
              } satisfies JellyfinRefreshState,
            },
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const task of tasks) {
          const refresh = jellyfinRefreshState(task)!;
          const attempts = refresh.attempts + 1;
          const delayMs = Math.min(5 * 60_000, 2 ** attempts * 5_000);
          this.tasks.update(task.id, {
            metadata: {
              ...task.metadata,
              jellyfinRefresh: {
                ...refresh,
                attempts,
                error: message.slice(0, 1000),
                nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
              } satisfies JellyfinRefreshState,
            },
          });
        }
      }
    }
  }

  private async awaitFallbackSelection(
    local: TaskSummary,
    reason: string,
  ): Promise<void> {
    const candidates = taskDownloadCandidates(local);
    const currentIndex = attemptIndex(local);
    const nextIndex = currentIndex + 1;
    const attempts = attemptHistory(local);
    attempts.push({
      index: currentIndex,
      candidateId: candidates[currentIndex]?.id,
      title: candidates[currentIndex]?.title,
      endedAt: new Date().toISOString(),
      reason,
    });

    if (local.externalId) {
      try {
        await this.openList.deleteOfflineTask(local.externalId);
      } catch (error) {
        if (!String(error).toLowerCase().includes("not found")) throw error;
      }
    }

    const remaining = candidates.slice(nextIndex);
    if (remaining.length === 0) {
      const failed = this.tasks.update(local.id, {
        state: "failed",
        progress: null,
        statusText: `${reason}；没有尚未尝试的备用资源`,
        externalId: null,
        metadata: {
          ...local.metadata,
          attempts,
          attemptIndex: currentIndex,
        },
      });
      this.outbox?.enqueueTaskResult(failed);
      return;
    }
    const waiting = this.tasks.update(local.id, {
      state: "waiting",
      progress: null,
      statusText: `${reason}；等待用户选择备用资源`,
      externalId: null,
      metadata: {
        ...local.metadata,
        attempts,
        awaitingFallbackSelection: true,
      },
    });
    this.enqueueFallbackPrompt(waiting, remaining);
  }

  private enqueueFallbackPrompt(
    task: TaskSummary,
    candidates: StoredDownloadCandidate[],
  ): void {
    if (!this.outbox || !task.userId) return;
    const target = notificationTarget(task.metadata.notificationTarget);
    const options = candidates
      .map((candidate, index) => `${index + 1}. ${candidate.title}`)
      .join("\n");
    const seconds = Math.round(
      (instantPolicy(task)?.timeoutMs ?? 40_000) / 1000,
    );
    this.outbox.enqueue({
      userId: task.userId,
      channel: target?.channel,
      providerInstanceId: target?.providerInstanceId,
      targetId: target?.targetId,
      text:
        `《${task.title}》刚刚选择的资源在 ${seconds} 秒内没有完成 115 离线转存，` +
        `本次尝试已判定失败并停止。\n是否改用以下备用资源？\n${options}\n` +
        "请回复要使用的资源名称或序号；未确认前不会下载备用资源。",
    });
  }

  private hasInstantPolicy(task: TaskSummary): boolean {
    return instantPolicy(task)?.enabled === true;
  }

  private isExpired(task: TaskSummary): boolean {
    const policy = instantPolicy(task);
    if (!policy?.enabled) return false;
    const startedAt = Date.parse(String(task.metadata.attemptStartedAt ?? ""));
    return (
      Number.isFinite(startedAt) &&
      Date.now() - startedAt >= policy.timeoutMs
    );
  }

  private timeoutMessage(task: TaskSummary): string {
    const timeoutSeconds = Math.round(
      (instantPolicy(task)?.timeoutMs ?? 40_000) / 1000,
    );
    return `115 离线任务在 ${timeoutSeconds} 秒内未完成，已删除原任务`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function inferState(
  task: OpenListTask,
): "running" | "completed" | "failed" | "cancelled" {
  switch (task.state) {
    case OPENLIST_TASK_STATE.succeeded:
      return "completed";
    case OPENLIST_TASK_STATE.canceled:
      return "cancelled";
    case OPENLIST_TASK_STATE.failed:
      return "failed";
    default:
      return "running";
  }
}

function validResultPath(
  destination: string,
  resultPath: string | undefined,
): resultPath is string {
  if (!destination.startsWith("/") || !resultPath?.startsWith("/")) {
    return false;
  }
  const normalizedDestination = destination.replace(/\/+$/, "") || "/";
  return normalizedDestination === "/"
    ? resultPath !== "/"
    : resultPath.startsWith(`${normalizedDestination}/`);
}

function parseProviderIds(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      Boolean(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function taskMediaType(task: TaskSummary): string | undefined {
  const media = task.metadata.media;
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    return undefined;
  }
  const type = (media as Record<string, unknown>).type;
  return typeof type === "string" ? type : undefined;
}

function instantPolicy(
  task: TaskSummary,
): { enabled: boolean; timeoutMs: number } | undefined {
  const value = task.metadata.instantOfflinePolicy;
  if (!value || typeof value !== "object") return undefined;
  const policy = value as Record<string, unknown>;
  const timeoutMs = Number(policy.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) return undefined;
  return { enabled: policy.enabled === true, timeoutMs };
}

function attemptIndex(task: TaskSummary): number {
  const value = Number(task.metadata.attemptIndex ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function attemptHistory(
  task: TaskSummary,
): Array<Record<string, unknown>> {
  return Array.isArray(task.metadata.attempts)
    ? [...(task.metadata.attempts as Array<Record<string, unknown>>)]
    : [];
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

function jellyfinRefreshState(
  task: TaskSummary,
): JellyfinRefreshState | undefined {
  const value = task.metadata.jellyfinRefresh;
  if (!value || typeof value !== "object") return undefined;
  const refresh = value as Partial<JellyfinRefreshState>;
  if (
    (refresh.state !== "pending" && refresh.state !== "completed") ||
    typeof refresh.path !== "string" ||
    !refresh.path.startsWith("/") ||
    typeof refresh.attempts !== "number" ||
    typeof refresh.nextAttemptAt !== "string"
  ) {
    return undefined;
  }
  return refresh as JellyfinRefreshState;
}
