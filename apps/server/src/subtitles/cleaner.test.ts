import { describe, expect, it, vi } from "vitest";
import type { GenerateRequest } from "../ai/types.js";
import type { ConfigStore } from "../db/config-store.js";
import type { PromptStore } from "../db/prompt-store.js";
import { SubtitleCleaner } from "./cleaner.js";

const source = `1\n00:00:01,000 --> 00:00:02,000\n字幕组招募\n\n2\n00:00:03,000 --> 00:00:04,000\n正片对白`;

describe("subtitle advertisement cleaner", () => {
  it("uses one isolated full-file request and removes only selected events", async () => {
    const requests: GenerateRequest[] = [];
    const cleaner = fixture(requests, async () => '{"remove":[0],"reason":"ad"}');

    const result = await cleaner.clean("episode.srt", Buffer.from(source));

    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    expect(requests[0]?.tools).toBeUndefined();
    expect(requests[0]?.messages[1]?.content).toContain("字幕组招募");
    expect(requests[0]?.messages[1]?.content).toContain("正片对白");
    expect(result.removed).toBe(1);
    expect(result.data.toString()).toBe(
      `1\n00:00:03,000 --> 00:00:04,000\n正片对白`,
    );
  });

  it("keeps the original downloaded subtitle when the AI request fails", async () => {
    const cleaner = fixture([], async () => {
      throw new Error("temporary provider failure");
    });

    const result = await cleaner.clean("episode.srt", Buffer.from(source));

    expect(result.removed).toBe(0);
    expect(result.data.toString()).toBe(source);
    expect(result.summary).toContain("已保留原字幕");
  });
});

function fixture(
  requests: GenerateRequest[],
  generate: (request: GenerateRequest) => Promise<string>,
): SubtitleCleaner {
  const configs = {
    defaultModel: () => ({ providerId: "provider-1", model: "test-model" }),
    provider: () => ({
      protocol: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      customHeaders: {},
      enabled: true,
    }),
  } as unknown as ConfigStore;
  const prompts = {
    get: vi.fn(() => "independent subtitle cleaner prompt"),
  } as unknown as PromptStore;
  return new SubtitleCleaner(
    configs,
    prompts,
    () => ({
      generate: async (request) => {
        requests.push(request);
        return {
          content: await generate(request),
          toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 20 },
          rawStopReason: "stop",
        };
      },
    }),
  );
}
