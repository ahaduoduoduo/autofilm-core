import type { ConfigStore } from "../db/config-store.js";
import type { OutboxMessage, OutboxStore } from "../db/outbox-store.js";
import type { UserStore } from "../db/user-store.js";
import {
  requestJson,
  ServiceHttpError,
} from "../integrations/http.js";

export class OutboundMessageWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly configs: ConfigStore,
    private readonly users: UserStore,
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
      for (const message of this.outbox.claimDue()) {
        await this.deliver(message);
      }
    } finally {
      this.running = false;
    }
  }

  private async deliver(message: OutboxMessage): Promise<void> {
    try {
      const destination = this.destination(message);
      const channel = this.configs.channelByInstance(
        "native",
        destination.providerInstanceId,
      );
      if (!channel?.enabled || !channel.baseUrl || !channel.outboundToken) {
        throw new Error("Outbound native channel is not configured");
      }
      await requestJson<Record<string, unknown>>(
        `${channel.baseUrl}/v1/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${channel.outboundToken}`,
          },
          body: JSON.stringify({
            provider_instance_id: destination.providerInstanceId,
            to: destination.targetId,
            messages: message.payload.messages,
          }),
        },
      );
      this.outbox.markSent(message.id);
    } catch (error) {
      if (
        error instanceof ServiceHttpError &&
        error.status === 409 &&
        error.responseBody.includes("no current context token")
      ) {
        this.outbox.defer(message.id, error.message);
        return;
      }
      this.outbox.markFailed(
        message.id,
        message.attempts,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private destination(message: OutboxMessage): {
    providerInstanceId: string;
    targetId: string;
  } {
    if (message.providerInstanceId && message.targetId) {
      return {
        providerInstanceId: message.providerInstanceId,
        targetId: message.targetId,
      };
    }
    if (!message.userId) throw new Error("Outbox message has no destination");
    const identity = this.users.activeIdentities(message.userId)[0];
    if (!identity) throw new Error("Member has no active chat identity");
    return {
      providerInstanceId: identity.providerInstanceId,
      targetId: identity.externalUserId,
    };
  }
}
