import { describe, expect, it } from "vitest";
import { recoverToolHistory } from "./history.js";

describe("recoverable AI tool history", () => {
  it("drops orphan and duplicate tool outputs", () => {
    expect(
      recoverToolHistory([
        {
          role: "tool",
          toolCallId: "orphan",
          content: "orphan output",
        },
        { role: "user", content: "find a movie" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: "call-1",
            name: "search_catalog",
            arguments: { query: "movie" },
          }],
        },
        { role: "tool", toolCallId: "call-1", content: "first" },
        { role: "tool", toolCallId: "call-1", content: "duplicate" },
      ]),
    ).toEqual([
      { role: "user", content: "find a movie" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-1",
          name: "search_catalog",
          arguments: { query: "movie" },
        }],
      },
      { role: "tool", toolCallId: "call-1", content: "first" },
    ]);
  });

  it("synthesizes a recoverable result for an interrupted tool call", () => {
    const recovered = recoverToolHistory([
      { role: "user", content: "download it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-complete",
            name: "list_download_tasks",
            arguments: {},
          },
          {
            id: "call-interrupted",
            name: "search_jellyfin",
            arguments: { query: "Example" },
          },
        ],
      },
      { role: "tool", toolCallId: "call-complete", content: "[]" },
      { role: "user", content: "continue" },
    ]);

    expect(recovered).toHaveLength(5);
    expect(recovered[2]).toEqual({
      role: "tool",
      toolCallId: "call-complete",
      content: "[]",
    });
    expect(recovered[3]).toMatchObject({
      role: "tool",
      toolCallId: "call-interrupted",
    });
    expect(JSON.parse(recovered[3]!.content)).toMatchObject({
      recoverable: true,
    });
    expect(recovered[4]).toEqual({ role: "user", content: "continue" });
  });
});
