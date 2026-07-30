import { describe, expect, it } from "vitest";
import { promptDefinition } from "./prompt.js";
import { formatToolResult } from "./service.js";

describe("agent tool result formatting", () => {
  it("preserves complete subtitle search, detail, and workspace results", () => {
    const content = "x".repeat(30_000);

    expect(formatToolResult("search_subtitle", content)).toBe(content);
    expect(formatToolResult("get_subtitle_detail", content)).toBe(content);
    expect(formatToolResult("get_subtitle_workspace", content)).toBe(content);
  });

  it("retains the general tool output limit", () => {
    const content = "x".repeat(30_000);
    const result = formatToolResult("search_releases", content);

    expect(result).toHaveLength(24_012);
    expect(result.endsWith("…[truncated]")).toBe(true);
  });
});

describe("main agent subtitle batching rules", () => {
  it("requires one workspace and one placement batch per request", () => {
    const prompt = promptDefinition("agent.main");

    expect(prompt?.version).toBe(11);
    expect(prompt?.content).toContain("必须共用一个 workspace");
    expect(prompt?.content).toContain("一次提交完整映射列表");
    expect(prompt?.content).toContain("不要重复创建");
  });
});
