import { describe, expect, it } from "vitest";
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
