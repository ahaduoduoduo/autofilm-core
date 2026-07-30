import { describe, expect, it } from "vitest";
import { agentMessages } from "./agent-messages.js";

describe("agent channel messages", () => {
  it("turns internal temporary media URLs into native image messages", () => {
    expect(
      agentMessages(
        "这是当前封面：\n\nhttp://autofilm-core:3100/v1/media/token_123-abc",
        "http://autofilm-core:3100",
      ),
    ).toEqual([
      { type: "text", text: "这是当前封面：" },
      {
        type: "image",
        media_url:
          "http://autofilm-core:3100/v1/media/token_123-abc",
      },
    ]);
  });

  it("leaves external links as text and deduplicates repeated media URLs", () => {
    const internal = "http://autofilm-core:3100/v1/media/image-token";
    expect(
      agentMessages(
        `候选：https://example.test/poster.jpg\n${internal}\n${internal}`,
        "http://autofilm-core:3100",
      ),
    ).toEqual([
      { type: "text", text: "候选：https://example.test/poster.jpg" },
      { type: "image", media_url: internal },
    ]);
  });
});
