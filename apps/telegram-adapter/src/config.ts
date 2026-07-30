import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export interface TelegramProcessConfig {
  host: string;
  port: number;
  dataDir: string;
  defaultCoreUrl: string;
  initialRuntime?: TelegramRuntimeConfig;
}

export interface TelegramRuntimeConfig {
  botToken: string;
  coreUrl: string;
  coreToken: string;
  outboundToken: string;
  providerInstanceId: string;
}

export class TelegramConfigStore {
  private readonly filePath: string;
  private readonly statePath: string;

  constructor(private readonly processConfig: TelegramProcessConfig) {
    mkdirSync(processConfig.dataDir, { recursive: true, mode: 0o700 });
    this.filePath = path.join(processConfig.dataDir, "telegram.json");
    this.statePath = path.join(processConfig.dataDir, "telegram-state.json");
  }

  load(): TelegramRuntimeConfig | undefined {
    try {
      return validateRuntime(
        JSON.parse(readFileSync(this.filePath, "utf8")) as unknown,
        this.processConfig.defaultCoreUrl,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return this.processConfig.initialRuntime;
      }
      throw error;
    }
  }

  save(config: TelegramRuntimeConfig): void {
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(config), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
  }

  loadOffset(config: TelegramRuntimeConfig): number {
    try {
      const value = JSON.parse(readFileSync(this.statePath, "utf8")) as {
        fingerprint?: string;
        offset?: number;
      };
      return value.fingerprint === fingerprint(config) &&
        Number.isInteger(value.offset) &&
        Number(value.offset) >= 0
        ? Number(value.offset)
        : 0;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return 0;
      }
      throw error;
    }
  }

  saveOffset(config: TelegramRuntimeConfig, offset: number): void {
    const temporaryPath = `${this.statePath}.tmp`;
    writeFileSync(
      temporaryPath,
      JSON.stringify({ fingerprint: fingerprint(config), offset }),
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, this.statePath);
  }
}

function fingerprint(config: TelegramRuntimeConfig): string {
  return createHash("sha256")
    .update(`${config.providerInstanceId}\n${config.botToken}`)
    .digest("hex");
}

export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
): TelegramProcessConfig {
  const defaultCoreUrl = validUrl(
    source.TELEGRAM_CORE_URL?.trim() || "http://autofilm-core:3100",
  );
  const botToken = source.TELEGRAM_BOT_TOKEN?.trim();
  const coreToken = source.TELEGRAM_CORE_TOKEN?.trim();
  const outboundToken = source.TELEGRAM_OUTBOUND_TOKEN?.trim();
  const configuredCount = [botToken, coreToken, outboundToken].filter(
    Boolean,
  ).length;
  if (configuredCount > 0 && configuredCount < 3) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN, TELEGRAM_CORE_TOKEN and TELEGRAM_OUTBOUND_TOKEN must be set together",
    );
  }
  return {
    host: source.TELEGRAM_HOST?.trim() || "0.0.0.0",
    port: integer(source.TELEGRAM_PORT, 18012, 1, 65_535),
    dataDir: path.resolve(source.TELEGRAM_DATA_DIR?.trim() || "/data"),
    defaultCoreUrl,
    initialRuntime:
      botToken && coreToken && outboundToken
        ? validateRuntime(
            {
              botToken,
              coreUrl: defaultCoreUrl,
              coreToken,
              outboundToken,
              providerInstanceId:
                source.TELEGRAM_PROVIDER_INSTANCE_ID?.trim() ||
                "telegram-main",
            },
            defaultCoreUrl,
          )
        : undefined,
  };
}

export function validateRuntime(
  value: unknown,
  defaultCoreUrl: string,
): TelegramRuntimeConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Telegram runtime configuration");
  }
  const input = value as Record<string, unknown>;
  const botToken = requiredString(input.botToken, "botToken");
  const coreToken = requiredString(input.coreToken, "coreToken");
  const outboundToken = requiredString(input.outboundToken, "outboundToken");
  if (coreToken.length < 24 || outboundToken.length < 24) {
    throw new Error("Telegram service tokens must contain at least 24 characters");
  }
  if (coreToken === outboundToken) {
    throw new Error("Telegram service tokens must be different");
  }
  return {
    botToken,
    coreUrl: validUrl(
      typeof input.coreUrl === "string" && input.coreUrl.trim()
        ? input.coreUrl.trim()
        : defaultCoreUrl,
    ).replace(/\/+$/, ""),
    coreToken,
    outboundToken,
    providerInstanceId:
      typeof input.providerInstanceId === "string" &&
      input.providerInstanceId.trim()
        ? input.providerInstanceId.trim()
        : "telegram-main",
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function validUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Telegram Core URL must use http or https");
  }
  return value;
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}
