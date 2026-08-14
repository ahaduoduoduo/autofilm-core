import type { AiTransportConfig } from "./types.js";

const DEFAULT_AI_REQUEST_TIMEOUT_MS = 120_000;

export class AiProviderError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "AiProviderError";
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? false;
  }
}

export function isTransientProviderMessage(message: string): boolean {
  const transient =
    /fetch failed|network error|timed? ?out|temporar(?:y|ily)|overloaded/i;
  const providerFailure =
    /server(?:s)? (?:had|has) an error|error occurred while processing your request/i;
  const retryInstruction =
    /try again later|rate.?limit|AI provider stream failed/i;
  return (
    transient.test(message) ||
    providerFailure.test(message) ||
    retryInstruction.test(message)
  );
}

export async function postJson<T>(
  config: AiTransportConfig,
  endpoint: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const text = await postText(config, endpoint, body, extraHeaders);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("AI provider returned invalid JSON");
  }
}

export async function postServerEvents<T>(
  config: AiTransportConfig,
  endpoint: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T[]> {
  const text = await postText(config, endpoint, body, {
    accept: "text/event-stream",
    ...extraHeaders,
  });
  if (!looksLikeEventStream(text)) {
    try {
      return [JSON.parse(text) as T];
    } catch {
      throw new Error("AI provider returned invalid JSON or event stream");
    }
  }

  const events: T[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as T);
    } catch {
      throw new Error("AI provider returned an invalid event stream payload");
    }
  }
  return events;
}

export function bearerHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export function joinUrl(baseUrl: string, endpoint: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function safeErrorText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 500) || "empty response";
}

async function postText(
  config: AiTransportConfig,
  endpoint: string,
  body: unknown,
  extraHeaders: Record<string, string>,
): Promise<string> {
  const response = await fetch(joinUrl(config.baseUrl, endpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...config.headers,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs(config)),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new AiProviderError(
      `AI provider returned HTTP ${response.status}: ${safeErrorText(text)}`,
      {
        status: response.status,
        retryAfterMs: retryAfterMilliseconds(
          response.headers.get("retry-after"),
        ),
        retryable:
          retryableHttpStatus(response.status) &&
          !isPermanentQuotaError(text),
      },
    );
  }
  return text;
}

function requestTimeoutMs(config: AiTransportConfig): number {
  const configured = config.requestTimeoutMs;
  return typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured > 0
    ? Math.floor(configured)
    : DEFAULT_AI_REQUEST_TIMEOUT_MS;
}

function looksLikeEventStream(text: string): boolean {
  return /(^|\r?\n)(event|data):/.test(text);
}

function retryableHttpStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function isPermanentQuotaError(text: string): boolean {
  return /insufficient_quota|spend_limit|usage_limit|billing|credit/i.test(text);
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}
