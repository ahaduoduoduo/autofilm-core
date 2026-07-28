import type { AiTransportConfig } from "./types.js";

export async function postJson<T>(
  config: AiTransportConfig,
  endpoint: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
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
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("AI provider returned invalid JSON");
  }
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
