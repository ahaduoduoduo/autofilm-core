import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { UserStore } from "./user-store.js";
import { UserMemoryStore } from "./user-memory-store.js";
import { ConversationStore } from "./conversation-store.js";

describe("per-user long-term memory", () => {
  it("adds, updates, lists, and deletes memories within one user", () => {
    const db = openDatabase(":memory:");
    const users = new UserStore(db);
    const memories = new UserMemoryStore(db);
    const first = users.create({
      username: "first",
      displayName: "First",
      role: "member",
    });
    const second = users.create({
      username: "second",
      displayName: "Second",
      role: "member",
    });

    const saved = memories.add({
      userId: first.id,
      category: "constraint",
      content: "1080p 资源不要推荐超过 40 GiB 的版本",
    });
    expect(memories.list(second.id)).toEqual([]);
    expect(memories.prompt(first.id)).toContain(saved.id);
    expect(memories.prompt(first.id)).toContain("40 GiB");
    const conversationInput = {
      userId: first.id,
      channel: "wechat",
      providerInstanceId: "wechat-main",
      externalConversationId: "chat-1",
    };
    const conversations = new ConversationStore(db);
    const conversationId = conversations.getOrCreate(conversationInput);
    conversations.append(conversationId, {
      role: "user",
      content: "临时聊天内容",
    });
    conversations.reset(conversationInput);
    expect(memories.list(first.id)).toHaveLength(1);

    const updated = memories.update({
      userId: first.id,
      id: saved.id,
      content: "1080p 资源不要推荐超过 30 GiB 的版本",
    });
    expect(updated.content).toContain("30 GiB");
    expect(memories.delete(second.id, saved.id)).toBe(false);
    expect(memories.delete(first.id, saved.id)).toBe(true);
    expect(memories.list(first.id)).toEqual([]);
    db.close();
  });

  it("does not duplicate an identical memory", () => {
    const db = openDatabase(":memory:");
    const users = new UserStore(db);
    const memories = new UserMemoryStore(db);
    const user = users.create({
      username: "member",
      displayName: "Member",
      role: "member",
    });
    const input = {
      userId: user.id,
      category: "preference" as const,
      content: "优先选择带中文音轨的版本",
    };
    const first = memories.add(input);
    const second = memories.add(input);

    expect(second.id).toBe(first.id);
    expect(memories.list(user.id)).toHaveLength(1);
    db.close();
  });
});
