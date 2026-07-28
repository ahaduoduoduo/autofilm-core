import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAiChatClient } from "./openai-chat.js";
import { OpenAiResponsesClient } from "./openai-responses.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function mockServer(
  handler: (body: Record<string, unknown>, headers: Record<string, unknown>) => unknown,
): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(handler(body, request.headers)));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

describe("AI protocol adapters", () => {
  it("maps OpenAI Responses tool calls to the canonical format", async () => {
    const baseUrl = await mockServer((body, headers) => {
      expect(headers.authorization).toBe("Bearer test-key");
      expect(body.model).toBe("example-model");
      return {
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "search_catalog",
            arguments: "{\"query\":\"Dune\"}",
          },
        ],
        usage: { input_tokens: 12, output_tokens: 4 },
        status: "completed",
      };
    });
    const client = new OpenAiResponsesClient({
      baseUrl,
      apiKey: "test-key",
    });
    const response = await client.generate({
      model: "example-model",
      messages: [{ role: "user", content: "find Dune" }],
      tools: [
        {
          name: "search_catalog",
          description: "search",
          parameters: { type: "object" },
        },
      ],
    });
    expect(response.toolCalls).toEqual([
      { id: "call-1", name: "search_catalog", arguments: { query: "Dune" } },
    ]);
    expect(response.usage.inputTokens).toBe(12);
  });

  it("maps Chat Completions text responses", async () => {
    const baseUrl = await mockServer(() => ({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "ready", tool_calls: [] },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }));
    const client = new OpenAiChatClient({ baseUrl, apiKey: "" });
    const response = await client.generate({
      model: "legacy-model",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(response.content).toBe("ready");
    expect(response.toolCalls).toEqual([]);
  });
});
