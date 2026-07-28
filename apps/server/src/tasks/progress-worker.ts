import type { TaskStore } from "../db/task-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { OpenListTask } from "../integrations/openlist.js";

interface OpenListTaskSource {
  listOfflineTasks(): Promise<OpenListTask[]>;
}

export class ProgressWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly openList: OpenListTaskSource,
    private readonly tasks: TaskStore,
    private readonly intervalMs = 15_000,
    private readonly outbox?: OutboxStore,
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
      const remoteTasks = await this.openList.listOfflineTasks();
      for (const remote of remoteTasks) this.updateFromRemote(remote);
    } catch {
      // OpenList is optional. Its connection state is surfaced by service tests.
    } finally {
      this.running = false;
    }
  }

  private updateFromRemote(remote: OpenListTask): void {
    const local = this.tasks.byExternalId(remote.id);
    if (!local) return;
    const state = inferState(remote);
    const updated = this.tasks.update(local.id, {
      state,
      progress: Number.isFinite(remote.progress)
        ? Math.max(0, Math.min(100, remote.progress))
        : null,
      statusText: remote.error || remote.status || state,
      metadata: {
        ...local.metadata,
        remoteName: remote.name,
        totalBytes: remote.total_bytes,
      },
    });
    if (
      !["completed", "failed", "cancelled"].includes(local.state) &&
      ["completed", "failed", "cancelled"].includes(updated.state)
    ) {
      this.outbox?.enqueueTaskResult(updated);
    }
  }
}

function inferState(
  task: OpenListTask,
): "running" | "completed" | "failed" | "cancelled" {
  if (task.error) return "failed";
  const status = task.status.toLowerCase();
  if (status.includes("cancel")) return "cancelled";
  if (task.end_time || task.progress >= 100) return "completed";
  return "running";
}
