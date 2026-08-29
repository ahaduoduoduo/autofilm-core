import type { AgentService } from "../agent/service.js";
import { agentMessages } from "../channels/agent-messages.js";
import type { AppDatabase } from "../db/database.js";
import type {
  NativeRequestJob,
  NativeRequestStore,
} from "../db/native-request-store.js";
import type { OutboxStore } from "../db/outbox-store.js";

type NativeAgent = Pick<AgentService, "respond" | "reset">;

export class NativeRequestWorker {
  private timer: NodeJS.Timeout | undefined;
  private active = 0;

  constructor(
    private readonly db: AppDatabase,
    private readonly requests: NativeRequestStore,
    private readonly agent: NativeAgent,
    private readonly outbox: OutboxStore,
    private readonly mediaBaseUrl: string,
    private readonly intervalMs = 1_000,
    private readonly concurrency = 4,
  ) {}

  start(): void {
    if (this.timer) return;
    this.db.transaction(() => {
      for (const job of this.requests.recoverInterrupted()) {
        this.notify(
          job,
          "请求因 Core 服务重启而中断。为避免重复执行已经产生副作用的操作，本次请求未自动重放，请重新发送。",
        );
      }
    })();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    const available = this.concurrency - this.active;
    if (available <= 0) return;
    for (const job of this.requests.claimPending(available)) {
      this.active += 1;
      void this.process(job)
        .catch((error) => {
          console.error(
            "Native request worker failed to persist a terminal state",
            error,
          );
        })
        .finally(() => {
          this.active -= 1;
          if (this.timer) this.tick();
        });
    }
  }

  private async process(job: NativeRequestJob): Promise<void> {
    try {
      if (job.eventType === "conversation.reset") {
        await this.agent.reset(agentInput(job));
        this.db.transaction(() => {
          this.notify(job, "当前会话记录已清除。");
          this.requests.markCompleted(job.eventId);
        })();
      } else {
        const content = await this.agent.respond({
          ...agentInput(job),
          text: job.text,
        });
        this.db.transaction(() => {
          this.outbox.enqueueMessages({
            userId: job.userId,
            channel: job.channel,
            providerInstanceId: job.providerInstanceId,
            targetId: job.externalConversationId,
            messages: agentMessages(content, this.mediaBaseUrl),
          });
          this.requests.markCompleted(job.eventId);
        })();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.db.transaction(() => {
        this.requests.markFailed(job.eventId, detail);
        this.notify(job, `请求处理失败：${detail}`);
      })();
    }
  }

  private notify(job: NativeRequestJob, text: string): void {
    this.outbox.enqueue({
      userId: job.userId,
      channel: job.channel,
      providerInstanceId: job.providerInstanceId,
      targetId: job.externalConversationId,
      text,
    });
  }
}

function agentInput(job: NativeRequestJob): {
  userId: string;
  channel: string;
  providerInstanceId: string;
  externalConversationId: string;
} {
  return {
    userId: job.userId,
    channel: job.channel,
    providerInstanceId: job.providerInstanceId,
    externalConversationId: job.externalConversationId,
  };
}
