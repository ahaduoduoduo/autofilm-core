import type { NativeOutboundMessage } from "@autofilm/contracts";
import type { ConfigStore } from "../db/config-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { EphemeralMediaStore } from "../db/media-store.js";
import type { UserStore } from "../db/user-store.js";
import type { OpenListClient } from "../integrations/openlist.js";

type AuthState = "unknown" | "authenticated" | "required";

export class OpenListAuthWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private state: AuthState = "unknown";

  constructor(
    private readonly openList: Pick<
      OpenListClient,
      "authState" | "authStorageId" | "startAuth" | "authQrCode"
    >,
    private readonly configs: Pick<ConfigStore, "listChannels">,
    private readonly users: Pick<UserStore, "listMembers">,
    private readonly outbox: Pick<OutboxStore, "enqueueMessages">,
    private readonly media: Pick<EphemeralMediaStore, "create">,
    private readonly mediaBaseUrl: string,
    private readonly intervalMs = 60_000,
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
      const state = await this.openList.authState();
      if (state.authenticated) {
        this.state = "authenticated";
        return;
      }
      if (
        state.state !== "risk_controlled" ||
        state.status_code !== 405
      ) {
        return;
      }
      if (this.state !== "required") {
        this.state = "required";
        await this.notifyAdministrators(state.message);
      }
    } catch (error) {
      console.error(
        `OpenList authentication state request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async notifyAdministrators(detail?: string): Promise<void> {
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
    const recipients: Array<{
      userId: string;
      channel: string;
      providerInstanceId: string;
      targetId: string;
    }> = [];
    const sent = new Set<string>();
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
        recipients.push({
          userId: member.id,
          channel: identity.channel,
          providerInstanceId: identity.providerInstanceId,
          targetId: identity.externalUserId,
        });
      }
    }
    if (recipients.length === 0) return;

    let messages: NativeOutboundMessage[];
    try {
      const storageId = this.openList.authStorageId();
      const session = await this.openList.startAuth(storageId);
      const qrCode = await this.openList.authQrCode(
        storageId,
        session.session_id,
      );
      const expiresAt = new Date(session.expires_at);
      const token = this.media.create({
        content: qrCode,
        contentType: "image/png",
        fileName: "openlist-115-auth.png",
        expiresAt: Number.isFinite(expiresAt.getTime())
          ? expiresAt
          : new Date(Date.now() + 10 * 60_000),
        reads: Math.max(10, recipients.length * 5),
      });
      messages = [
        {
          type: "text" as const,
          text: "OpenList 的 115 存储触发 HTTP 405 风控。请使用 115 客户端扫描下方二维码，登录信息将自动更新。",
        },
        {
          type: "image" as const,
          media_url: `${this.mediaBaseUrl}/v1/media/${token}`,
          file_name: "openlist-115-auth.png",
        },
      ];
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`OpenList QR generation failed: ${reason}`);
      const suffix = detail ? `\nOpenList 返回：${detail.slice(0, 500)}` : "";
      messages = [
        {
          type: "text" as const,
          text:
            `OpenList 的 115 存储触发 HTTP 405 风控，但自动生成二维码失败：${reason}。请打开 OpenList 的 115 存储配置页面重新扫码。` +
            suffix,
        },
      ];
    }

    for (const recipient of recipients) {
      this.outbox.enqueueMessages({
        ...recipient,
        messages,
      });
    }
  }
}
