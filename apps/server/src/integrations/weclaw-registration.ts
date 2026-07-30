import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ConfigStore } from "../db/config-store.js";
import { hashToken } from "../security/tokens.js";

const weClawConfigSchema = z.object({
  agents: z.record(
    z.string(),
    z.object({
      type: z.string(),
      api_key: z.string().min(24),
      outbound_token: z.string().min(1),
    }).passthrough(),
  ),
});

const accountSchema = z.object({
  ilink_bot_id: z.string().trim().min(1),
});

export interface WeClawStatus {
  available: boolean;
  configReady: boolean;
  accounts: Array<{
    providerInstanceId: string;
    configured: boolean;
    enabled: boolean;
  }>;
}

export class WeClawRegistration {
  readonly #configs: ConfigStore;
  readonly #dataDir?: string;
  readonly #baseUrl: string;
  readonly #agentName: string;

  constructor(input: {
    configs: ConfigStore;
    dataDir?: string;
    baseUrl: string;
    agentName?: string;
  }) {
    this.#configs = input.configs;
    this.#dataDir = input.dataDir;
    this.#baseUrl = input.baseUrl.replace(/\/+$/, "");
    this.#agentName = input.agentName ?? "autofilm";
  }

  async status(): Promise<WeClawStatus> {
    const discovered = await this.#discover();
    const channels = this.#configs.listChannels();
    return {
      available: Boolean(this.#dataDir),
      configReady: Boolean(discovered.agent),
      accounts: discovered.botIds.map((providerInstanceId) => {
        const channel = channels.find(
          (item) =>
            item.type === "native" &&
            item.providerInstanceId === providerInstanceId,
        );
        return {
          providerInstanceId,
          configured: Boolean(channel),
          enabled: channel?.enabled ?? false,
        };
      }),
    };
  }

  async reconcile(enabled?: boolean): Promise<WeClawStatus> {
    const discovered = await this.#discover();
    if (!discovered.agent) return this.status();

    for (const providerInstanceId of discovered.botIds) {
      const existing = this.#configs
        .listChannels()
        .find(
          (item) =>
            item.type === "native" &&
            item.providerInstanceId === providerInstanceId,
        );
      const secret = existing
        ? this.#configs.channelByInstance("native", providerInstanceId)
        : undefined;
      const nextEnabled = enabled ?? existing?.enabled ?? true;
      const unchanged =
        existing?.baseUrl === this.#baseUrl &&
        existing.enabled === nextEnabled &&
        secret?.inboundTokenHash === hashToken(discovered.agent.apiKey) &&
        secret.outboundToken === discovered.agent.outboundToken;
      if (unchanged) continue;

      this.#configs.saveChannel({
        id: existing?.id,
        name: weChatChannelName(providerInstanceId),
        type: "native",
        providerInstanceId,
        baseUrl: this.#baseUrl,
        inboundToken: discovered.agent.apiKey,
        outboundToken: discovered.agent.outboundToken,
        enabled: nextEnabled,
      });
    }
    return this.status();
  }

  async #discover(): Promise<{
    agent?: { apiKey: string; outboundToken: string };
    botIds: string[];
  }> {
    if (!this.#dataDir) return { botIds: [] };
    const [agent, botIds] = await Promise.all([
      this.#readAgent(),
      this.#readAccounts(),
    ]);
    return { agent, botIds };
  }

  async #readAgent(): Promise<
    { apiKey: string; outboundToken: string } | undefined
  > {
    try {
      const raw = await readFile(path.join(this.#dataDir!, "config.json"), "utf8");
      const config = weClawConfigSchema.parse(JSON.parse(raw));
      const agent = config.agents[this.#agentName];
      if (!agent || agent.type !== "native") return undefined;
      return {
        apiKey: agent.api_key,
        outboundToken: agent.outbound_token,
      };
    } catch {
      return undefined;
    }
  }

  async #readAccounts(): Promise<string[]> {
    const accountsDir = path.join(this.#dataDir!, "accounts");
    try {
      const entries = await readdir(accountsDir, { withFileTypes: true });
      const botIds = await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith(".json") &&
              !entry.name.endsWith(".sync.json"),
          )
          .map(async (entry) => {
            try {
              const raw = await readFile(path.join(accountsDir, entry.name), "utf8");
              return accountSchema.parse(JSON.parse(raw)).ilink_bot_id;
            } catch {
              return undefined;
            }
          }),
      );
      return [...new Set(botIds.filter((item): item is string => Boolean(item)))];
    } catch {
      return [];
    }
  }
}

function weChatChannelName(providerInstanceId: string): string {
  const shortId = providerInstanceId.split("@")[0]?.slice(0, 8);
  return shortId ? `微信 ${shortId}` : "微信";
}
