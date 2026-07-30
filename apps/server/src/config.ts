import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const schema = z.object({
  AUTOFILM_HOST: z.string().default("0.0.0.0"),
  AUTOFILM_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  AUTOFILM_DATA_DIR: z.string().default("./data"),
  AUTOFILM_PUBLIC_URL: z.string().url().default("http://localhost:3100"),
  AUTOFILM_MEDIA_BASE_URL: z.string().url().optional(),
  AUTOFILM_TELEGRAM_ADAPTER_URL: z
    .string()
    .url()
    .default("http://telegram-adapter:18012"),
  AUTOFILM_WECLAW_DATA_DIR: z.string().optional(),
  AUTOFILM_WECLAW_URL: z.string().url().default("http://weclaw:18011"),
  AUTOFILM_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  AUTOFILM_MASTER_KEY: z.string().min(1),
  AUTOFILM_ADMIN_USERNAME: z.string().optional(),
  AUTOFILM_ADMIN_PASSWORD: z.string().optional(),
  AUTOFILM_BOOTSTRAP_AI_NAME: z.string().optional(),
  AUTOFILM_BOOTSTRAP_AI_PROTOCOL: z
    .enum([
      "openai-responses",
      "openai-chat-completions",
      "anthropic-messages",
      "gemini-generate-content",
    ])
    .optional(),
  AUTOFILM_BOOTSTRAP_AI_BASE_URL: z.string().url().optional(),
  AUTOFILM_BOOTSTRAP_AI_API_KEY: z.string().optional(),
  AUTOFILM_BOOTSTRAP_AI_MODEL: z.string().optional(),
  AUTOFILM_WATCHLIST_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .default(21_600),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid AutoFilm configuration: ${details}`);
  }

  const dataDir = path.resolve(parsed.data.AUTOFILM_DATA_DIR);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  return {
    host: parsed.data.AUTOFILM_HOST,
    port: parsed.data.AUTOFILM_PORT,
    dataDir,
    databasePath: path.join(dataDir, "autofilm.sqlite"),
    publicUrl: parsed.data.AUTOFILM_PUBLIC_URL.replace(/\/+$/, ""),
    mediaBaseUrl: (
      parsed.data.AUTOFILM_MEDIA_BASE_URL ??
      parsed.data.AUTOFILM_PUBLIC_URL
    ).replace(/\/+$/, ""),
    telegramAdapterUrl:
      parsed.data.AUTOFILM_TELEGRAM_ADAPTER_URL.replace(/\/+$/, ""),
    weClawDataDir: emptyToUndefined(parsed.data.AUTOFILM_WECLAW_DATA_DIR),
    weClawUrl: parsed.data.AUTOFILM_WECLAW_URL.replace(/\/+$/, ""),
    logLevel: parsed.data.AUTOFILM_LOG_LEVEL,
    masterKey: parsed.data.AUTOFILM_MASTER_KEY,
    adminUsername: emptyToUndefined(parsed.data.AUTOFILM_ADMIN_USERNAME),
    adminPassword: emptyToUndefined(parsed.data.AUTOFILM_ADMIN_PASSWORD),
    watchlistIntervalMs:
      parsed.data.AUTOFILM_WATCHLIST_INTERVAL_SECONDS * 1000,
    bootstrapAi:
      parsed.data.AUTOFILM_BOOTSTRAP_AI_PROTOCOL &&
      parsed.data.AUTOFILM_BOOTSTRAP_AI_BASE_URL &&
      parsed.data.AUTOFILM_BOOTSTRAP_AI_MODEL
        ? {
            name: parsed.data.AUTOFILM_BOOTSTRAP_AI_NAME ?? "Primary AI",
            protocol: parsed.data.AUTOFILM_BOOTSTRAP_AI_PROTOCOL,
            baseUrl: parsed.data.AUTOFILM_BOOTSTRAP_AI_BASE_URL,
            apiKey: parsed.data.AUTOFILM_BOOTSTRAP_AI_API_KEY ?? "",
            model: parsed.data.AUTOFILM_BOOTSTRAP_AI_MODEL,
          }
        : undefined,
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
