import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest } from "../ai/types.js";
import type { ConfigStore } from "../db/config-store.js";
import type { PromptStore } from "../db/prompt-store.js";
import { SubtitleMainlandRewriter } from "./mainland-rewriter.js";

const source = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}我有在考虑这件事\\NI've been thinking about it.\nDialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,这句话已经很自然\\NThis line is already natural.`;

describe("mainland subtitle rewriter", () => {
  it("uses one isolated full-subtitle request and applies only returned Chinese", async () => {
    const requests: GenerateRequest[] = [];
    const rewriter = fixture(requests, {
      changes: [
        {
          id: 0,
          chinese_segments: [{ index: 0, text: "我一直在考虑这件事" }],
        },
      ],
    });

    const result = await rewriter.rewrite("episode.ass", Buffer.from(source));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    expect(requests[0]?.tools).toBeUndefined();
    expect(requests[0]?.messages[1]?.content).toContain(
      "I've been thinking about it.",
    );
    expect(requests[0]?.messages[1]?.content).toContain(
      "This line is already natural.",
    );
    expect(result.rewrittenEvents).toBe(1);
    expect(result.rewrittenSegments).toBe(1);
    expect(result.data.toString()).toBe(
      source.replace("我有在考虑这件事", "我一直在考虑这件事"),
    );
  });

  it("rejects returned text that modifies non-Chinese content", async () => {
    const rewriter = fixture([], {
      changes: [
        {
          id: 0,
          chinese_segments: [{ index: 0, text: "我一直在thinking" }],
        },
      ],
    });

    await expect(
      rewriter.rewrite("episode.ass", Buffer.from(source)),
    ).rejects.toThrow("修改了非中文内容");
  });
});

function fixture(
  requests: GenerateRequest[],
  response: Record<string, unknown>,
): SubtitleMainlandRewriter {
  const configs = {
    defaultModel: () => ({
      id: "model-1",
      providerId: "provider-1",
      name: "Default",
      model: "test-model",
      isDefault: true,
      enabled: true,
      temperature: 0,
      maxOutputTokens: 16_384,
      contextWindowTokens: 128_000,
      autoCompactTokenLimit: null,
      compactKeepRecentTokens: 20_000,
      toolOutputTokenLimit: 12_000,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    }),
    provider: () => ({
      id: "provider-1",
      protocol: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      customHeaders: {},
      enabled: true,
    }),
  } as unknown as ConfigStore;
  const prompts = {
    get: vi.fn(() => "independent mainland subtitle prompt"),
  } as unknown as PromptStore;
  return new SubtitleMainlandRewriter(
    configs,
    prompts,
    () => ({
      generate: async (request) => {
        requests.push(request);
        return {
          content: JSON.stringify(response),
          toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 50 },
          rawStopReason: "stop",
        };
      },
    }),
  );
}
