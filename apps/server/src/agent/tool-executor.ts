import type { ToolCall } from "../ai/types.js";
import type { AgentTool } from "./tool-types.js";

export interface ExecutedToolCall {
  call: ToolCall;
  content: string;
}

export async function executeToolCalls(
  calls: ToolCall[],
  tools: AgentTool[],
): Promise<ExecutedToolCall[]> {
  return Promise.all(
    calls.map(async (call) => {
      const tool = tools.find(
        (candidate) => candidate.definition.name === call.name,
      );
      if (!tool) {
        return {
          call,
          content: JSON.stringify({ error: `Unknown tool: ${call.name}` }),
        };
      }
      try {
        return {
          call,
          content: JSON.stringify(await tool.execute(call.arguments)),
        };
      } catch (error) {
        return {
          call,
          content: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }),
  );
}
