import type { AiTransportConfig } from "./types.js";

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
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `AI provider returned HTTP ${response.status}: ${safeErrorText(text)}`,
    );
  }
  return text;
}

function looksLikeEventStream(text: string): boolean {
  return /(^|\r?\n)(event|data):/.test(text);
}
