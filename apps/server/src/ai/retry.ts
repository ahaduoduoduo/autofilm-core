import {
  AiProviderError,
  isTransientProviderMessage,
} from "./http.js";
import type {
  AiClient,
  GenerateRequest,
  GenerateResponse,
} from "./types.js";

const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

export interface AiRetryOptions {
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export function withAutomaticRetry(
  client: AiClient,
  options: AiRetryOptions = {},
): AiClient {
  return new RetryingAiClient(client, options);
}

class RetryingAiClient implements AiClient {
  private readonly maxRetries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly client: AiClient,
    options: AiRetryOptions,
  ) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = options.sleep ?? delay;
    this.random = options.random ?? Math.random;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    for (let retry = 0; ; retry += 1) {
      try {
        return await this.client.generate(request);
      } catch (error) {
        if (retry >= this.maxRetries || !isRetryableAiError(error)) {
          throw error;
        }
        const waitMs = retryDelayMilliseconds(error, retry, this.random);
        console.warn("AI provider request failed; retrying", {
          attempt: retry + 1,
          maxRetries: this.maxRetries,
          waitMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.sleep(waitMs);
      }
    }
  }
}

export function isRetryableAiError(error: unknown): boolean {
  if (error instanceof AiProviderError) return error.retryable;
  if (!(error instanceof Error)) return false;

  const code = (error as Error & { code?: string }).code ?? "";
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code)
  ) {
    return true;
  }
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;

  return isTransientProviderMessage(error.message);
}

function retryDelayMilliseconds(
  error: unknown,
  retry: number,
  random: () => number,
): number {
  if (error instanceof AiProviderError && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  const jitter = Math.floor(random() * 250);
  return BASE_RETRY_DELAY_MS * 2 ** retry + jitter;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
