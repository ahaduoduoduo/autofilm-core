import { randomUUID } from "node:crypto";
import type {
  AiProtocol,
  AiProviderSummary,
  ChannelConfigSummary,
  ModelProfile,
  ServiceConfigSummary,
  ServiceType,
} from "@autofilm/contracts";
import { DEFAULT_MEDIA_LIBRARY_ROOTS } from "@autofilm/contracts";
import type { AppDatabase } from "./database.js";
import type { SecretVault } from "../security/vault.js";
import { hashToken } from "../security/tokens.js";

interface ProviderRow {
  id: string;
  name: string;
  protocol: AiProtocol;
  base_url: string;
  api_key_encrypted: string | null;
  custom_headers_encrypted: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface ModelRow {
  id: string;
  provider_id: string;
  name: string;
  model: string;
  is_default: number;
  enabled: number;
  temperature: number | null;
  max_output_tokens: number | null;
  created_at: string;
  updated_at: string;
}

interface ChannelRow {
  id: string;
  name: string;
  type: "native";
  provider_instance_id: string;
  base_url: string;
  inbound_token_hash: string | null;
  outbound_token_encrypted: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface ServiceRow {
  id: string;
  name: string;
  type: ServiceType;
  base_url: string;
  credential_encrypted: string | null;
  options_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderSecret extends AiProviderSummary {
  apiKey: string;
}

export interface ChannelSecret extends ChannelConfigSummary {
  inboundTokenHash: string;
  outboundToken: string;
}

export interface ServiceSecret extends ServiceConfigSummary {
  credential: string;
}

export class ConfigStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly vault: SecretVault,
  ) {}

  listProviders(): AiProviderSummary[] {
    return (this.db.prepare("SELECT * FROM ai_providers ORDER BY created_at").all() as ProviderRow[]).map(
      (row) => this.providerSummary(row),
    );
  }

  provider(id: string): ProviderSecret | undefined {
    const row = this.db.prepare("SELECT * FROM ai_providers WHERE id = ?").get(id) as
      | ProviderRow
      | undefined;
    return row
      ? { ...this.providerSummary(row), apiKey: this.vault.decrypt(row.api_key_encrypted) }
      : undefined;
  }

  saveProvider(input: {
    id?: string;
    name: string;
    protocol: AiProtocol;
    baseUrl: string;
    apiKey?: string;
    customHeaders?: Record<string, string>;
    enabled: boolean;
  }): AiProviderSummary {
    const existing = input.id ? this.provider(input.id) : undefined;
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    const createdAt = existing?.createdAt ?? now;
    const apiKeyEncrypted =
      input.apiKey === undefined && existing
        ? this.vault.encrypt(existing.apiKey)
        : this.vault.encrypt(input.apiKey ?? "");
    const headers = input.customHeaders ?? existing?.customHeaders ?? {};
    this.db
      .prepare(
        `INSERT INTO ai_providers
          (id, name, protocol, base_url, api_key_encrypted, custom_headers_encrypted, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, protocol=excluded.protocol, base_url=excluded.base_url,
           api_key_encrypted=excluded.api_key_encrypted,
           custom_headers_encrypted=excluded.custom_headers_encrypted,
           enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.name,
        input.protocol,
        normalizeBaseUrl(input.baseUrl),
        apiKeyEncrypted || null,
        this.vault.encrypt(JSON.stringify(headers)) || null,
        Number(input.enabled),
        createdAt,
        now,
      );
    return this.listProviders().find((item) => item.id === id)!;
  }

  deleteProvider(id: string): void {
    this.db.prepare("DELETE FROM ai_providers WHERE id = ?").run(id);
  }

  listModels(): ModelProfile[] {
    return (this.db.prepare("SELECT * FROM model_profiles ORDER BY is_default DESC, created_at").all() as ModelRow[]).map(
      toModel,
    );
  }

  model(id: string): ModelProfile | undefined {
    const row = this.db.prepare("SELECT * FROM model_profiles WHERE id = ?").get(id) as
      | ModelRow
      | undefined;
    return row ? toModel(row) : undefined;
  }

  defaultModel(): ModelProfile | undefined {
    const row = this.db
      .prepare(
        `SELECT m.* FROM model_profiles m
         JOIN ai_providers p ON p.id = m.provider_id
         WHERE m.is_default = 1 AND m.enabled = 1 AND p.enabled = 1`,
      )
      .get() as ModelRow | undefined;
    return row ? toModel(row) : undefined;
  }

  saveModel(input: {
    id?: string;
    providerId: string;
    name: string;
    model: string;
    isDefault: boolean;
    enabled: boolean;
    temperature?: number | null;
    maxOutputTokens?: number | null;
  }): ModelProfile {
    const existing = input.id ? this.model(input.id) : undefined;
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      if (input.isDefault) {
        this.db.prepare("UPDATE model_profiles SET is_default = 0").run();
      }
      this.db
        .prepare(
          `INSERT INTO model_profiles
            (id, provider_id, name, model, is_default, enabled, temperature, max_output_tokens, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             provider_id=excluded.provider_id, name=excluded.name, model=excluded.model,
             is_default=excluded.is_default, enabled=excluded.enabled,
             temperature=excluded.temperature, max_output_tokens=excluded.max_output_tokens,
             updated_at=excluded.updated_at`,
        )
        .run(
          id,
          input.providerId,
          input.name,
          input.model,
          Number(input.isDefault),
          Number(input.enabled),
          input.temperature ?? null,
          input.maxOutputTokens ?? null,
          existing?.createdAt ?? now,
          now,
        );
    })();
    return this.model(id)!;
  }

  deleteModel(id: string): void {
    this.db.prepare("DELETE FROM model_profiles WHERE id = ?").run(id);
  }

  listChannels(): ChannelConfigSummary[] {
    return (this.db.prepare("SELECT * FROM channel_configs ORDER BY created_at").all() as ChannelRow[]).map(
      toChannel,
    );
  }

  channelByInstance(
    type: string,
    providerInstanceId: string,
  ): ChannelSecret | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM channel_configs WHERE type = ? AND provider_instance_id = ?",
      )
      .get(type, providerInstanceId) as ChannelRow | undefined;
    return row
      ? {
          ...toChannel(row),
          inboundTokenHash: row.inbound_token_hash ?? "",
          outboundToken: this.vault.decrypt(row.outbound_token_encrypted),
        }
      : undefined;
  }

  saveChannel(input: {
    id?: string;
    name: string;
    type: "native";
    providerInstanceId: string;
    baseUrl: string;
    inboundToken?: string;
    outboundToken?: string;
    enabled: boolean;
  }): ChannelConfigSummary {
    const previous = input.id
      ? (this.db.prepare("SELECT * FROM channel_configs WHERE id = ?").get(input.id) as
          | ChannelRow
          | undefined)
      : undefined;
    const id = previous?.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_configs
          (id, name, type, provider_instance_id, base_url, inbound_token_hash,
           outbound_token_encrypted, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, type=excluded.type,
           provider_instance_id=excluded.provider_instance_id, base_url=excluded.base_url,
           inbound_token_hash=excluded.inbound_token_hash,
           outbound_token_encrypted=excluded.outbound_token_encrypted,
           enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.name,
        input.type,
        input.providerInstanceId,
        normalizeBaseUrl(input.baseUrl),
        input.inboundToken === undefined
          ? previous?.inbound_token_hash ?? null
          : hashToken(input.inboundToken),
        input.outboundToken === undefined
          ? previous?.outbound_token_encrypted ?? null
          : this.vault.encrypt(input.outboundToken),
        Number(input.enabled),
        previous?.created_at ?? now,
        now,
      );
    return this.listChannels().find((item) => item.id === id)!;
  }

  deleteChannel(id: string): void {
    this.db.prepare("DELETE FROM channel_configs WHERE id = ?").run(id);
  }

  listServices(): ServiceConfigSummary[] {
    return (this.db.prepare("SELECT * FROM service_configs ORDER BY created_at").all() as ServiceRow[]).map(
      toService,
    );
  }

  serviceById(id: string): ServiceSecret | undefined {
    const row = this.db
      .prepare("SELECT * FROM service_configs WHERE id = ?")
      .get(id) as ServiceRow | undefined;
    return row
      ? { ...toService(row), credential: this.vault.decrypt(row.credential_encrypted) }
      : undefined;
  }

  service(type: ServiceType): ServiceSecret | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM service_configs WHERE type = ? AND enabled = 1 ORDER BY created_at LIMIT 1",
      )
      .get(type) as ServiceRow | undefined;
    return row
      ? { ...toService(row), credential: this.vault.decrypt(row.credential_encrypted) }
      : undefined;
  }

  saveService(input: {
    id?: string;
    name: string;
    type: ServiceType;
    baseUrl: string;
    credential?: string;
    options: Record<string, unknown>;
    enabled: boolean;
  }): ServiceConfigSummary {
    const previous = input.id
      ? (this.db.prepare("SELECT * FROM service_configs WHERE id = ?").get(input.id) as
          | ServiceRow
          | undefined)
      : undefined;
    const id = previous?.id ?? randomUUID();
    const now = new Date().toISOString();
    const options =
      input.type === "openlist"
        ? {
            movieLibraryRoot: DEFAULT_MEDIA_LIBRARY_ROOTS.movie,
            tvLibraryRoot: DEFAULT_MEDIA_LIBRARY_ROOTS.tv,
            ...input.options,
          }
        : input.options;
    this.db.transaction(() => {
      if (input.enabled) {
        this.db
          .prepare(
            "UPDATE service_configs SET enabled = 0, updated_at = ? WHERE type = ? AND id != ?",
          )
          .run(now, input.type, id);
      }
      this.db
        .prepare(
          `INSERT INTO service_configs
          (id, name, type, base_url, credential_encrypted, options_json,
           enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, type=excluded.type, base_url=excluded.base_url,
           credential_encrypted=excluded.credential_encrypted,
           options_json=excluded.options_json, enabled=excluded.enabled,
           updated_at=excluded.updated_at`,
        )
        .run(
          id,
          input.name,
          input.type,
          normalizeBaseUrl(input.baseUrl),
          input.credential === undefined
            ? previous?.credential_encrypted ?? null
            : this.vault.encrypt(input.credential),
          JSON.stringify(options),
          Number(input.enabled),
          previous?.created_at ?? now,
          now,
        );
    })();
    return this.listServices().find((item) => item.id === id)!;
  }

  deleteService(id: string): void {
    this.db.prepare("DELETE FROM service_configs WHERE id = ?").run(id);
  }

  private providerSummary(row: ProviderRow): AiProviderSummary {
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      baseUrl: row.base_url,
      enabled: Boolean(row.enabled),
      hasApiKey: Boolean(row.api_key_encrypted),
      customHeaders: JSON.parse(
        this.vault.decrypt(row.custom_headers_encrypted) || "{}",
      ) as Record<string, string>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function toModel(row: ModelRow): ModelProfile {
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    model: row.model,
    isDefault: Boolean(row.is_default),
    enabled: Boolean(row.enabled),
    temperature: row.temperature,
    maxOutputTokens: row.max_output_tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toChannel(row: ChannelRow): ChannelConfigSummary {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    providerInstanceId: row.provider_instance_id,
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    hasInboundToken: Boolean(row.inbound_token_hash),
    hasOutboundToken: Boolean(row.outbound_token_encrypted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toService(row: ServiceRow): ServiceConfigSummary {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    hasCredential: Boolean(row.credential_encrypted),
    options: JSON.parse(row.options_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
