import { describe, expect, it } from "vitest";
import type { AgentTool } from "./tool-types.js";
import { executeToolCalls } from "./tool-executor.js";

describe("parallel tool execution", () => {
  it("starts every tool before waiting for any result and preserves call order", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = (name: string): AgentTool => ({
      definition: {
        name,
        description: name,
        parameters: { type: "object" },
      },
      execute: async () => {
        started += 1;
        await gate;
        return { name };
      },
    });

    const running = executeToolCalls(
      [
        { id: "first", name: "search_releases", arguments: {} },
        { id: "second", name: "search_subtitle", arguments: {} },
      ],
      [tool("search_releases"), tool("search_subtitle")],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(started).toBe(2);
    release();
    const results = await running;
    expect(results.map((result) => result.call.id)).toEqual([
      "first",
      "second",
    ]);
  });
});
