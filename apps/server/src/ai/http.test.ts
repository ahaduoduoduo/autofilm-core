import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson } from "./http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI HTTP transport", () => {
  it("honors a request-specific timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          const abort = () => reject(signal.reason ?? new Error("aborted"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
      ),
    );

    await expect(
      postJson(
        {
          baseUrl: "https://example.test/v1",
          apiKey: "",
          requestTimeoutMs: 5,
        },
        "responses",
        {},
      ),
    ).rejects.toThrow(/timeout/i);
  });
});
