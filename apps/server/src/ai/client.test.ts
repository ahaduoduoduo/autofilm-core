import { describe, expect, it } from "vitest";
import { withRecoverableHistory } from "./client.js";
import type {
  AiClient,
  GenerateRequest,
  GenerateResponse,
} from "./types.js";

describe("recoverable AI client", () => {
  it("retries a provider tool-history rejection with the latest user turn", async () => {
    const requests: GenerateRequest[] = [];
    const inner: AiClient = {
      async generate(request) {
        requests.push(request);
        if (requests.length === 1) {
          throw new Error(
            "No tool call found for function call output with call_id old-call",
          );
        }
        return response("recovered");
      },
    };
    const client = withRecoverableHistory(inner);

    await expect(
      client.generate({
        model: "example",
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "old request" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "current request" },
        ],
      }),
    ).resolves.toMatchObject({ content: "recovered" });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "current request" },
    ]);
  });

  it("does not retry unrelated provider errors", async () => {
    const inner: AiClient = {
      async generate() {
        throw new Error("AI provider returned HTTP 401");
      },
    };
    const client = withRecoverableHistory(inner);

    await expect(
      client.generate({
        model: "example",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow("HTTP 401");
  });
});

function response(content: string): GenerateResponse {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
