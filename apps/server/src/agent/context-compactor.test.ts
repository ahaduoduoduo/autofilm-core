import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProfile } from "@autofilm/contracts";
import type { AiClient } from "../ai/types.js";
import { openDatabase } from "../db/database.js";
import { ConversationStore } from "../db/conversation-store.js";
import { PromptStore } from "../db/prompt-store.js";
import { UserStore } from "../db/user-store.js";
import { LocalContextCompactor } from "./context-compactor.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local conversation context compaction", () => {
  it("persists a replacement view and leaves raw messages unchanged", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-compact-"));
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const users = new UserStore(database);
    const conversations = new ConversationStore(database);
    const user = users.create({
      username: "compactor-member",
      displayName: "Compactor Member",
      role: "member",
    });
    const conversationId = conversations.getOrCreate({
      userId: user.id,
      channel: "wechat",
      providerInstanceId: "wechat-main",
      externalConversationId: "compactor@wechat",
    });
    conversations.append(conversationId, {
      role: "user",
      content: "升级电影 A，完成后继续放置字幕。",
    });
    conversations.append(conversationId, {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        name: "start_media_upgrades",
        arguments: { upgrade_selection_id: "selection-1" },
      }],
    });
    conversations.append(conversationId, {
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify({ state: "running", taskId: "task-1" }),
    });
    conversations.append(conversationId, {
      role: "user",
      content: `近期原始要求：继续等待任务完成。${"近".repeat(1_500)}`,
    });
    const requests: string[] = [];
    const client: AiClient = {
      async generate(request) {
        requests.push(request.messages.at(-1)?.content ?? "");
        return {
          content:
            "当前目标：升级电影 A 后放置字幕。\n关键状态：task-1 正在运行。",
          toolCalls: [],
          usage: { inputTokens: 200, outputTokens: 30 },
        };
      },
    };
    const model: ModelProfile = {
      id: "model",
      providerId: "provider",
      name: "Model",
      model: "test-model",
      isDefault: true,
      enabled: true,
      temperature: null,
      maxOutputTokens: null,
      contextWindowTokens: 128_000,
      autoCompactTokenLimit: null,
      toolOutputTokenLimit: 12_000,
      compactKeepRecentTokens: 1_000,
      createdAt: "now",
      updatedAt: "now",
    };
    const result = await new LocalContextCompactor(
      conversations,
      new PromptStore(database),
    ).compact({
      conversationId,
      client,
      model,
      policy: {
        contextWindowTokens: 128_000,
        autoCompactTokenLimit: 100_000,
        compactionReserveTokens: 28_000,
        compactKeepRecentTokens: 1_000,
        toolOutputTokenLimit: 12_000,
      },
    });

    expect(result.compacted).toBe(true);
    expect(requests[0]).toContain("task-1");
    expect(
      (database
        .prepare("SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?")
        .get(conversationId) as { total: number }).total,
    ).toBe(4);
    const view = conversations.modelHistory(conversationId);
    expect(view).toHaveLength(2);
    expect(view[0]?.content).toContain("task-1 正在运行");
    expect(view[0]?.content).toContain("放置字幕");
    expect(view[1]?.content).toContain("近期原始要求");
    database.close();
  });
});
