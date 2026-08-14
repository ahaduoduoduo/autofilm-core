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

  it("summarizes large prefixes with bounded concurrency and writes one checkpoint", async () => {
    const fixture = multiChunkFixture("parallel");
    let active = 0;
    let maximumActive = 0;
    let chunkCalls = 0;
    let mergeCalls = 0;
    const client: AiClient = {
      async generate(request) {
        if (isChunkRequest(request)) {
          chunkCalls += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await delay(10);
          active -= 1;
          return aiResponse(`分块草稿 ${chunkId(request)}`);
        }
        mergeCalls += 1;
        return aiResponse("唯一最终检查点：保留全部关键状态。");
      },
    };

    const result = await fixture.compactor.compact({
      conversationId: fixture.conversationId,
      client,
      model: fixture.model,
      policy: fixture.policy,
    });

    expect(result.compacted).toBe(true);
    expect(chunkCalls).toBe(5);
    expect(maximumActive).toBe(3);
    expect(mergeCalls).toBe(1);
    expect(compactionChunkCount(fixture.database, fixture.conversationId)).toBe(0);
    const view = fixture.conversations.modelHistory(fixture.conversationId);
    expect(view).toHaveLength(2);
    expect(view[0]?.content).toContain("唯一最终检查点");
    expect(view[0]?.content).not.toContain("分块 1/5");
    expect(view[1]?.content).toContain("近期原始消息");
    expect(rawMessageCount(fixture.database, fixture.conversationId)).toBe(6);
    fixture.database.close();
  });

  it("reuses successful chunk drafts after a later chunk fails", async () => {
    const fixture = multiChunkFixture("chunk-resume");
    const firstInputs: string[] = [];
    const firstClient: AiClient = {
      async generate(request) {
        if (!isChunkRequest(request)) {
          throw new Error("merge must not run");
        }
        const id = chunkId(request);
        firstInputs.push(id);
        if (id === "old-1") throw new Error("temporary chunk failure");
        await delay(10);
        return aiResponse(`已保存 ${id}`);
      },
    };

    await expect(
      fixture.compactor.compact({
        conversationId: fixture.conversationId,
        client: firstClient,
        model: fixture.model,
        policy: fixture.policy,
      }),
    ).rejects.toThrow("temporary chunk failure");
    expect(firstInputs.sort()).toEqual(["old-0", "old-1", "old-2"]);
    expect(compactionChunkCount(fixture.database, fixture.conversationId)).toBe(2);

    const resumedInputs: string[] = [];
    const resumedClient: AiClient = {
      async generate(request) {
        if (isChunkRequest(request)) {
          resumedInputs.push(chunkId(request));
          return aiResponse(`恢复 ${chunkId(request)}`);
        }
        return aiResponse("恢复后的唯一检查点");
      },
    };
    await fixture.compactor.compact({
      conversationId: fixture.conversationId,
      client: resumedClient,
      model: fixture.model,
      policy: fixture.policy,
    });

    expect(resumedInputs.sort()).toEqual(["old-1", "old-3", "old-4"]);
    expect(compactionChunkCount(fixture.database, fixture.conversationId)).toBe(0);
    expect(fixture.conversations.modelHistory(fixture.conversationId)[0]?.content)
      .toContain("恢复后的唯一检查点");
    fixture.database.close();
  });

  it("retries only the final merge when every chunk draft already exists", async () => {
    const fixture = multiChunkFixture("merge-resume");
    let initialChunkCalls = 0;
    const firstClient: AiClient = {
      async generate(request) {
        if (isChunkRequest(request)) {
          initialChunkCalls += 1;
          return aiResponse(`草稿 ${chunkId(request)}`);
        }
        throw new Error("temporary merge failure");
      },
    };

    await expect(
      fixture.compactor.compact({
        conversationId: fixture.conversationId,
        client: firstClient,
        model: fixture.model,
        policy: fixture.policy,
      }),
    ).rejects.toThrow("temporary merge failure");
    expect(initialChunkCalls).toBe(5);
    expect(compactionChunkCount(fixture.database, fixture.conversationId)).toBe(5);

    let resumedChunkCalls = 0;
    let resumedMergeCalls = 0;
    const resumedClient: AiClient = {
      async generate(request) {
        if (isChunkRequest(request)) {
          resumedChunkCalls += 1;
          return aiResponse("unexpected chunk");
        }
        resumedMergeCalls += 1;
        return aiResponse("仅重试合并后的唯一检查点");
      },
    };
    await fixture.compactor.compact({
      conversationId: fixture.conversationId,
      client: resumedClient,
      model: fixture.model,
      policy: fixture.policy,
    });

    expect(resumedChunkCalls).toBe(0);
    expect(resumedMergeCalls).toBe(1);
    expect(compactionChunkCount(fixture.database, fixture.conversationId)).toBe(0);
    fixture.database.close();
  });
});

function multiChunkFixture(label: string) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), `autofilm-compact-${label}-`),
  );
  directories.push(directory);
  const database = openDatabase(path.join(directory, "test.sqlite"));
  const users = new UserStore(database);
  const conversations = new ConversationStore(database);
  const user = users.create({
    username: `${label}-member`,
    displayName: `${label} Member`,
    role: "member",
  });
  const conversationId = conversations.getOrCreate({
    userId: user.id,
    channel: "wechat",
    providerInstanceId: "wechat-main",
    externalConversationId: `${label}@wechat`,
  });
  for (let index = 0; index < 5; index += 1) {
    conversations.append(conversationId, {
      role: index % 2 === 0 ? "user" : "assistant",
      content: `old-${index} ${"旧".repeat(3_500)}`,
    });
  }
  conversations.append(conversationId, {
    role: "user",
    content: `近期原始消息 ${"近".repeat(1_500)}`,
  });
  const model: ModelProfile = {
    id: "model",
    providerId: "provider",
    name: "Model",
    model: "test-model",
    isDefault: true,
    enabled: true,
    temperature: null,
    maxOutputTokens: null,
    contextWindowTokens: 8_000,
    autoCompactTokenLimit: null,
    toolOutputTokenLimit: 1_000,
    compactKeepRecentTokens: 1_000,
    createdAt: "now",
    updatedAt: "now",
  };
  return {
    database,
    conversations,
    conversationId,
    model,
    policy: {
      contextWindowTokens: 8_000,
      autoCompactTokenLimit: 6_000,
      compactionReserveTokens: 2_000,
      compactKeepRecentTokens: 1_000,
      toolOutputTokenLimit: 1_000,
    },
    compactor: new LocalContextCompactor(
      conversations,
      new PromptStore(database),
    ),
  };
}

function isChunkRequest(request: Parameters<AiClient["generate"]>[0]): boolean {
  return request.messages[0]?.content.includes("临时分块草稿") ?? false;
}

function chunkId(request: Parameters<AiClient["generate"]>[0]): string {
  return request.messages.at(-1)?.content.match(/old-\d+/)?.[0] ?? "unknown";
}

function aiResponse(content: string) {
  return {
    content,
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function compactionChunkCount(
  database: ReturnType<typeof openDatabase>,
  conversationId: string,
): number {
  return (
    database
      .prepare(
        `SELECT COUNT(*) AS total FROM conversation_compaction_chunks
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as { total: number }
  ).total;
}

function rawMessageCount(
  database: ReturnType<typeof openDatabase>,
  conversationId: string,
): number {
  return (
    database
      .prepare(
        "SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?",
      )
      .get(conversationId) as { total: number }
  ).total;
}
