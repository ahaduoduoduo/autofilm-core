import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "./conversation-store.js";
import { openDatabase } from "./database.js";
import { UserStore } from "./user-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("conversation history", () => {
  it("expands a numeric limit to preserve the complete user tool turn", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "autofilm-conversation-"),
    );
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const users = new UserStore(database);
    const conversations = new ConversationStore(database);
    const user = users.create({
      username: "history-member",
      displayName: "History Member",
      role: "member",
    });
    const conversationId = conversations.getOrCreate({
      userId: user.id,
      channel: "wechat",
      providerInstanceId: "wechat-main",
      externalConversationId: "member@wechat",
    });
    conversations.append(conversationId, {
      role: "user",
      content: "find a movie",
    });
    conversations.append(conversationId, {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-catalog",
        name: "search_catalog",
        arguments: { query: "movie" },
      }],
    });
    conversations.append(conversationId, {
      role: "tool",
      toolCallId: "call-catalog",
      content: "[]",
    });

    expect(conversations.history(conversationId, 1)).toEqual([
      { role: "user", content: "find a movie" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-catalog",
          name: "search_catalog",
          arguments: { query: "movie" },
        }],
      },
      {
        role: "tool",
        content: "[]",
        toolCallId: "call-catalog",
      },
    ]);
    database.close();
  });

  it("uses insertion order when timestamps are identical", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "autofilm-conversation-"),
    );
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const users = new UserStore(database);
    const conversations = new ConversationStore(database);
    const user = users.create({
      username: "ordered-member",
      displayName: "Ordered Member",
      role: "member",
    });
    const conversationId = conversations.getOrCreate({
      userId: user.id,
      channel: "wechat",
      providerInstanceId: "wechat-main",
      externalConversationId: "ordered@wechat",
    });
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
      conversations.history(conversationId).map((message) => message.content),
    ).toEqual(["one", "two", "three"]);
    database.close();
  });
});
