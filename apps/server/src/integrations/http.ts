export interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data: T;
}

export class ServiceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`Service returned HTTP ${status}: ${responseBody.slice(0, 500)}`);
    this.name = "ServiceHttpError";
  }
}

export async function requestJson<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ServiceHttpError(response.status, text);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Service returned invalid JSON");
  }
}

export async function requestEnvelope<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  const envelope = await requestJson<ApiEnvelope<T>>(url, init);
  if (envelope.code !== 200) {
    throw new Error(envelope.message || `Service returned code ${envelope.code}`);
  }
  return envelope.data;
}

export async function requestOk(
  url: string,
  init: RequestInit,
): Promise<void> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new ServiceHttpError(response.status, text);
  }
}

export function jsonHeaders(
  credential = "",
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(credential ? { authorization: credential } : {}),
    ...extra,
  };
}

export function withQuery(
  baseUrl: string,
  path: string,
  query: Record<string, string>,
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(query)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}
