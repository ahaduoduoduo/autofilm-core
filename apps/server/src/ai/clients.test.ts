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

async function mockSseServer(
  handler: (
    body: Record<string, unknown>,
    headers: Record<string, unknown>,
  ) => unknown[],
): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      response.setHeader("content-type", "text/event-stream");
      for (const event of handler(body, request.headers)) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

describe("AI protocol adapters", () => {
  it("streams OpenAI Responses and maps tool calls to the canonical format", async () => {
    const baseUrl = await mockSseServer((body, headers) => {
      expect(headers.authorization).toBe("Bearer test-key");
      expect(body.model).toBe("example-model");
      expect(body.stream).toBe(true);
      return [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "item-1",
            call_id: "call-1",
            name: "search_catalog",
            arguments: "",
          },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 0,
          delta: "{\"query\":\"Dune\"}",
        },
        {
          type: "response.completed",
          response: {
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
          },
        },
      ];
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

  it("collects text deltas when a compatible Responses stream omits the final response", async () => {
    const baseUrl = await mockSseServer((body) => {
      expect(body.stream).toBe(true);
      return [
        { type: "response.output_text.delta", delta: "正" },
        { type: "response.output_text.delta", delta: "常" },
        { type: "response.output_text.done", text: "正常" },
        {
          type: "response.completed",
          response: {
            output: [],
            status: "completed",
            usage: { input_tokens: 2, output_tokens: 1 },
          },
        },
      ];
    });
    const client = new OpenAiResponsesClient({ baseUrl, apiKey: "" });
    const response = await client.generate({
      model: "stream-only-model",
      messages: [{ role: "user", content: "ping" }],
    });
    expect(response.content).toBe("正常");
    expect(response.usage.inputTokens).toBe(2);
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

  it("sends captcha images as an isolated Responses multimodal message", async () => {
    const baseUrl = await mockServer((body) => {
      expect(body.instructions).toBe("OCR only");
      const input = body.input as Array<Record<string, unknown>>;
      const content = input[0]!.content as Array<Record<string, unknown>>;
      expect(content).toEqual([
        { type: "input_text", text: "read" },
        {
          type: "input_image",
          image_url: "data:image/png;base64,cG5n",
        },
      ]);
      return { output_text: "A1B2", output: [], usage: {} };
    });
    const client = new OpenAiResponsesClient({ baseUrl, apiKey: "" });
    const response = await client.generate({
      model: "vision",
      messages: [
        { role: "system", content: "OCR only" },
        {
          role: "user",
          content: "read",
          images: [{ mediaType: "image/png", dataBase64: "cG5n" }],
        },
      ],
    });
    expect(response.content).toBe("A1B2");
  });

  it("sends captcha images using Chat Completions image_url parts", async () => {
    const baseUrl = await mockServer((body) => {
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages[0]!.content).toEqual([
        { type: "text", text: "read" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,cG5n" },
        },
      ]);
      return {
        choices: [{ message: { content: "A1B2", tool_calls: [] } }],
        usage: {},
      };
    });
    const client = new OpenAiChatClient({ baseUrl, apiKey: "" });
    const response = await client.generate({
      model: "vision",
      messages: [
        {
          role: "user",
          content: "read",
          images: [{ mediaType: "image/png", dataBase64: "cG5n" }],
        },
      ],
    });
    expect(response.content).toBe("A1B2");
  });
});
