import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "./conversation-store.js";
import { openDatabase, type AppDatabase } from "./database.js";
import { UserStore } from "./user-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("conversation history", () => {
  it("keeps the complete raw history until token compaction is written", () => {
    const { database, conversations, conversationId } = fixture("complete");
    for (let index = 0; index < 90; index += 1) {
      conversations.append(conversationId, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index}`,
      });
    }

    const history = conversations.modelHistory(conversationId);
    expect(history).toHaveLength(90);
    expect(history[0]?.content).toBe("message-0");
    expect(history.at(-1)?.content).toBe("message-89");
    database.close();
  });

  it("uses insertion order when timestamps are identical", () => {
    const { database, conversations, conversationId } = fixture("ordered");
    conversations.append(conversationId, { role: "user", content: "one" });
    conversations.append(conversationId, {
      role: "assistant",
      content: "two",
    });
    conversations.append(conversationId, { role: "user", content: "three" });
    database
      .prepare(
        "UPDATE messages SET created_at = ? WHERE conversation_id = ?",
      )
      .run("2026-07-30T00:00:00.000Z", conversationId);

    expect(
      conversations.modelHistory(conversationId).map((item) => item.content),
    ).toEqual(["one", "two", "three"]);
    database.close();
  });

  it("rolls the checkpoint forward while keeping the recent token tail raw", () => {
    const { database, conversations, conversationId } = fixture("rolling");
    conversations.append(conversationId, {
      role: "user",
      content: `旧目标 ${"甲".repeat(2_000)}`,
    });
    conversations.append(conversationId, {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-old",
        name: "search_catalog",
        arguments: { query: "电影 A" },
      }],
    });
    const oldTool = conversations.append(conversationId, {
      role: "tool",
      toolCallId: "call-old",
      content: JSON.stringify({ id: 1, title: "电影 A" }),
    });
    conversations.append(conversationId, {
      role: "user",
      content: `近期原话 ${"乙".repeat(1_500)}`,
    });

    const firstPlan = conversations.compactionPlan(conversationId, {
      keepRecentTokens: 1_000,
      toolOutputTokenLimit: 500,
    });
    expect(firstPlan?.messages).toHaveLength(3);
    expect(firstPlan?.targetSequence).toBe(oldTool.sequence);
    conversations.saveCompaction({
      conversationId,
      throughSequence: firstPlan!.targetSequence,
      summary: "目标：电影 A。关键标识：TMDB 1。",
      sourceTokenEstimate: 2_100,
      summaryTokenEstimate: 20,
      compactionCount: 1,
    });

    let view = conversations.modelHistory(conversationId);
    expect(view).toHaveLength(2);
    expect(view[0]?.content).toContain("TMDB 1");
    expect(view[1]?.content).toContain("近期原话");

    conversations.append(conversationId, {
      role: "assistant",
      content: `处理中 ${"丙".repeat(1_500)}`,
    });
    conversations.append(conversationId, {
      role: "user",
      content: `最新原话 ${"丁".repeat(1_500)}`,
    });
    const secondPlan = conversations.compactionPlan(conversationId, {
      keepRecentTokens: 1_000,
      toolOutputTokenLimit: 500,
    });
    expect(secondPlan?.previousSummary).toContain("TMDB 1");
    expect(secondPlan?.messages[0]?.content).toContain("近期原话");
    expect(secondPlan?.messages[1]?.content).toContain("处理中");
    conversations.saveCompaction({
      conversationId,
      throughSequence: secondPlan!.targetSequence,
      summary: "目标：电影 A。进度：处理中。",
      sourceTokenEstimate: 3_000,
      summaryTokenEstimate: 20,
      compactionCount: 2,
    });

    view = conversations.modelHistory(conversationId);
    expect(view).toHaveLength(2);
    expect(view[0]?.content).toContain("进度：处理中");
    expect(view[1]?.content).toContain("最新原话");
    expect(rawMessageCount(database, conversationId)).toBe(6);
    database.close();
  });

  it("never starts the retained tail with an isolated tool result", () => {
    const { database, conversations, conversationId } = fixture("tool-pair");
    conversations.append(conversationId, {
      role: "user",
      content: "查询电影 A",
    });
    conversations.append(conversationId, {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        name: "search_catalog",
        arguments: { query: "电影 A" },
      }],
    });
    conversations.append(conversationId, {
      role: "tool",
      toolCallId: "call-1",
      content: "结".repeat(2_000),
    });

    const plan = conversations.compactionPlan(conversationId, {
      keepRecentTokens: 1_000,
      toolOutputTokenLimit: 2_000,
    });
    expect(plan?.messages).toEqual([{ role: "user", content: "查询电影 A" }]);
    expect(plan?.splitTurn).toBe(true);
    database.close();
  });

  it("clears both raw history and its checkpoint", () => {
    const { database, conversations, conversationId, identity } =
      fixture("reset");
    const message = conversations.append(conversationId, {
      role: "user",
      content: "旧消息",
    });
    conversations.saveCompaction({
      conversationId,
      throughSequence: message.sequence,
      summary: "旧检查点",
      sourceTokenEstimate: 10,
      summaryTokenEstimate: 5,
      compactionCount: 1,
    });
    conversations.saveCompactionChunk({
      conversationId,
      sourceHash: "draft-before-reset",
      summary: "未完成的临时分块",
      sourceTokenEstimate: 20,
      summaryTokenEstimate: 10,
    });

    conversations.reset(identity);
    expect(conversations.modelHistory(conversationId)).toEqual([]);
    expect(rawMessageCount(database, conversationId)).toBe(0);
    expect(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS total FROM conversation_compaction_chunks
             WHERE conversation_id = ?`,
          )
          .get(conversationId) as { total: number }
      ).total,
    ).toBe(0);
    database.close();
  });
});

function fixture(label: string): {
  database: AppDatabase;
  conversations: ConversationStore;
  conversationId: string;
  identity: {
    userId: string;
    channel: string;
    providerInstanceId: string;
    externalConversationId: string;
  };
} {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), `autofilm-conversation-${label}-`),
  );
  directories.push(directory);
  const database = openDatabase(path.join(directory, "test.sqlite"));
  const users = new UserStore(database);
  const user = users.create({
    username: `${label}-member`,
    displayName: `${label} Member`,
    role: "member",
  });
  const identity = {
    userId: user.id,
    channel: "wechat",
    providerInstanceId: "wechat-main",
    externalConversationId: `${label}@wechat`,
  };
  const conversations = new ConversationStore(database);
  return {
    database,
    conversations,
    conversationId: conversations.getOrCreate(identity),
    identity,
  };
}

function rawMessageCount(database: AppDatabase, conversationId: string): number {
  return (
    database
      .prepare("SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { total: number }
  ).total;
}
