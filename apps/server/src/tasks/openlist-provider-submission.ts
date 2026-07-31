import { setTimeout as delay } from "node:timers/promises";
import {
  OPENLIST_TASK_STATE,
  type OpenListTask,
} from "../integrations/openlist.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface ProviderSubmissionSource {
  listOfflineTasks(): Promise<OpenListTask[]>;
  deleteOfflineTask(taskId: string): Promise<void>;
}

export interface ProviderSubmissionReceipt {
  submissionStatus: "succeeded";
  message: "离线下载提交成功";
  taskId: string;
  title: string;
  destination?: string;
  providerSubmittedAt: string;
}

export type ProviderSubmittedTask = OpenListTask & {
  provider_task_id: string;
  provider_submitted_at: string;
};

export async function waitForProviderSubmission(
  source: ProviderSubmissionSource,
  initialTask: OpenListTask,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<ProviderSubmittedTask> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let task: OpenListTask | undefined = initialTask;

  while (true) {
    if (hasProviderSubmission(task)) return task;
    if (!task || isTerminal(task)) {
      const reason = submissionFailure(task);
      const cleanupError = await deleteTask(source, initialTask.id);
      throw new Error(withCleanupError(reason, cleanupError));
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const reason =
        `OpenList 在 ${Math.round(timeoutMs / 1000)} 秒内未能将任务提交给 115`;
      const cleanupError = await deleteTask(source, initialTask.id);
      throw new Error(withCleanupError(reason, cleanupError));
    }

    await delay(Math.min(pollIntervalMs, remainingMs));
    task = (await source.listOfflineTasks()).find(
      (candidate) => candidate.id === initialTask.id,
    );
  }
}

export function hasProviderSubmission(
  task: OpenListTask | undefined,
): task is ProviderSubmittedTask {
  return Boolean(
    task?.provider_task_id?.trim() &&
      task.provider_submitted_at &&
      Number.isFinite(Date.parse(task.provider_submitted_at)),
  );
}

export function providerSubmissionMetadata(
  metadata: Record<string, unknown>,
  task: ProviderSubmittedTask,
): Record<string, unknown> {
  return {
    ...metadata,
    remoteName: task.name,
    openListTaskId: task.id,
    providerTaskId: task.provider_task_id,
    providerSubmittedAt: task.provider_submitted_at,
    attemptStartedAt: task.provider_submitted_at,
    lastRemoteState: task.state,
    lastRemoteStatus: task.status,
    lastRemoteObservedAt: new Date().toISOString(),
  };
}

export function providerSubmissionReceipt(input: {
  taskId: string;
  title: string;
  destination?: unknown;
  providerSubmittedAt: string;
}): ProviderSubmissionReceipt {
  return {
    submissionStatus: "succeeded",
    message: "离线下载提交成功",
    taskId: input.taskId,
    title: input.title,
    ...(typeof input.destination === "string"
      ? { destination: input.destination }
      : {}),
    providerSubmittedAt: input.providerSubmittedAt,
  };
}

function isTerminal(task: OpenListTask): boolean {
  switch (task.state) {
    case OPENLIST_TASK_STATE.succeeded:
    case OPENLIST_TASK_STATE.canceled:
    case OPENLIST_TASK_STATE.failed:
      return true;
    default:
      return false;
  }
}

function submissionFailure(task: OpenListTask | undefined): string {
  if (!task) return "OpenList 提交任务已结束，115 未接受该离线下载";
  const detail = task.error?.trim() || task.status?.trim();
  return detail
    ? `115 离线下载提交失败：${detail}`
    : "115 离线下载提交失败";
}

async function deleteTask(
  source: ProviderSubmissionSource,
  taskId: string,
): Promise<string | undefined> {
  try {
    await source.deleteOfflineTask(taskId);
    return undefined;
  } catch (error) {
    if (String(error).toLowerCase().includes("not found")) return undefined;
    return error instanceof Error ? error.message : String(error);
  }
}

function withCleanupError(reason: string, cleanupError?: string): string {
  return cleanupError
    ? `${reason}；取消 OpenList 本地任务失败：${cleanupError}`
    : reason;
}
