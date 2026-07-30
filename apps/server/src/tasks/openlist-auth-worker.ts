import type { ConfigStore } from "../db/config-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { UserStore } from "../db/user-store.js";
import type { OpenListClient } from "../integrations/openlist.js";

type AuthState = "unknown" | "authenticated" | "required";

export class OpenListAuthWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private state: AuthState = "unknown";

  constructor(
    private readonly openList: Pick<OpenListClient, "authHealth">,
    private readonly configs: Pick<ConfigStore, "listChannels">,
    private readonly users: Pick<UserStore, "listMembers">,
    private readonly outbox: Pick<OutboxStore, "enqueue">,
    private readonly intervalMs = 10 * 60_000,
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
      const health = await this.openList.authHealth();
      if (health.authenticated) {
        this.state = "authenticated";
        return;
      }
      if (this.state !== "required") {
        this.notifyAdministrators(health.message);
      }
      this.state = "required";
    } catch (error) {
      console.error(
        `OpenList authentication health request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private notifyAdministrators(detail?: string): void {
    const channels = new Set(
      this.configs
        .listChannels()
        .filter(
          (channel) =>
            channel.enabled &&
            Boolean(channel.baseUrl) &&
            channel.hasOutboundToken,
        )
        .map((channel) => channel.providerInstanceId),
    );
    const sent = new Set<string>();
    const suffix = detail ? `\nOpenList 返回：${detail}` : "";
    for (const member of this.users.listMembers()) {
      if (
        member.status !== "active" ||
        !["owner", "admin"].includes(member.role)
      ) {
        continue;
      }
      for (const identity of member.identities) {
        if (
          identity.status !== "active" ||
          !channels.has(identity.providerInstanceId)
        ) {
          continue;
        }
        const key = `${identity.providerInstanceId}\n${identity.externalUserId}`;
        if (sent.has(key)) continue;
        sent.add(key);
        this.outbox.enqueue({
          userId: member.id,
          channel: identity.channel,
          providerInstanceId: identity.providerInstanceId,
          targetId: identity.externalUserId,
          text:
            "OpenList 的 115 登录凭据已经失效，需要重新扫码。请在 AutoFilm 管理页面的服务设置中打开 OpenList 扫码登录。" +
            suffix,
        });
      }
    }
  }
}
