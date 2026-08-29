import { describe, expect, it } from "vitest";
import {
  contextBudgetPolicy,
  estimateGenerateRequestTokens,
  estimateTextTokens,
  limitToolOutputs,
  truncateTextToTokenBudget,
} from "./token-budget.js";

describe("AI context token budgets", () => {
  it("uses conservative estimates for ASCII and Chinese text", () => {
    expect(estimateTextTokens("abcdef")).toBe(2);
    expect(estimateTextTokens("字幕测试")).toBe(4);
    expect(estimateTextTokens("abc字幕")).toBe(3);
  });

  it("reserves output space and keeps a separate recent raw token tail", () => {
    expect(
      contextBudgetPolicy({
        contextWindowTokens: 100_000,
        autoCompactTokenLimit: null,
        compactKeepRecentTokens: 20_000,
        toolOutputTokenLimit: 5_000,
      }),
    ).toEqual({
      contextWindowTokens: 100_000,
      autoCompactTokenLimit: 83_616,
      compactionReserveTokens: 16_384,
      compactKeepRecentTokens: 20_000,
      toolOutputTokenLimit: 5_000,
    });
    expect(
      contextBudgetPolicy({
        contextWindowTokens: 100_000,
        autoCompactTokenLimit: 99_000,
        compactKeepRecentTokens: 20_000,
        toolOutputTokenLimit: 5_000,
      }),
    ).toMatchObject({
      autoCompactTokenLimit: 95_904,
      compactionReserveTokens: 4_096,
      compactKeepRecentTokens: 20_000,
    });
  });

  it("keeps the beginning and end when a tool result is limited", () => {
    const content = `START-${"x".repeat(30_000)}-END`;
    const [limited] = limitToolOutputs(
      [{ role: "tool", toolCallId: "call-1", content }],
      1_000,
    );
    expect(limited?.content).toContain("START-");
    expect(limited?.content).toContain("-END");
    expect(limited?.content).toContain("工具结果已限制");
    expect(estimateTextTokens(limited?.content ?? "")).toBeLessThanOrEqual(
      1_010,
    );
  });

  it("accounts for messages, tool calls, and tool definitions", () => {
    const tokens = estimateGenerateRequestTokens(
      [
        { role: "system", content: "system" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "one", name: "search", arguments: { q: "电影" } }],
        },
      ],
      [{ name: "search", description: "搜索", parameters: { type: "object" } }],
    );
    expect(tokens).toBeGreaterThan(30);
    expect(truncateTextToTokenBudget("字幕".repeat(100), 20)).toContain(
      "上下文预算省略",
    );
  });
});
