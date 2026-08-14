import { describe, expect, it } from "vitest";
import { runtimeSystemPrompt } from "./runtime-context.js";

describe("main agent runtime context", () => {
  it("rebuilds the system prompt with current time and user memory", () => {
    const first = runtimeSystemPrompt(
      "主系统提示词",
      "## 当前成员长期记忆\n- memory-1：偏好 ASS 字幕",
      new Date("2026-08-14T12:00:00.000Z"),
    );
    const second = runtimeSystemPrompt(
      "主系统提示词",
      "## 当前成员长期记忆\n- memory-2：偏好 4K",
      new Date("2026-08-14T12:05:00.000Z"),
    );

    expect(first).toContain("主系统提示词");
    expect(first).toContain("memory-1：偏好 ASS 字幕");
    expect(first).toContain("2026-08-14T12:00:00.000Z");
    expect(second).toContain("memory-2：偏好 4K");
    expect(second).not.toContain("memory-1");
    expect(second).toContain("2026-08-14T12:05:00.000Z");
  });
});
