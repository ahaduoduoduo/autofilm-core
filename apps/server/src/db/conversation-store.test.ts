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

  it("keeps raw messages while replacing an archived media topic with a summary", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "autofilm-conversation-"),
    );
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const users = new UserStore(database);
    const conversations = new ConversationStore(database);
    const user = users.create({
      username: "memory-member",
      displayName: "Memory Member",
      role: "member",
    });
    const conversationId = conversations.getOrCreate({
      userId: user.id,
      channel: "wechat",
      providerInstanceId: "wechat-main",
      externalConversationId: "memory@wechat",
    });
    const first = conversations.append(conversationId, {
      role: "user",
      content: "讨论电影 A",
    });
    conversations.commitTopicSwitch(
      conversationId,
      {
        mediaType: "movie",
        tmdbId: 1,
        title: "电影 A",
        productionYear: 2020,
      },
      first.id,
    );
    conversations.append(conversationId, {
      role: "assistant",
      content: "电影 A 已经下载完成",
    });
    const second = conversations.append(conversationId, {
      role: "user",
      content: "接下来讨论电影 B",
    });
    const plan = conversations.planTopicSwitch(
      conversationId,
      {
        mediaType: "movie",
        tmdbId: 2,
        title: "电影 B",
        productionYear: 2021,
      },
      second.id,
    );

    expect(plan.messages.map((message) => message.content)).toEqual([
      "讨论电影 A",
      "电影 A 已经下载完成",
    ]);
    conversations.commitTopicSwitch(
      conversationId,
      {
        mediaType: "movie",
        tmdbId: 2,
        title: "电影 B",
        productionYear: 2021,
      },
      second.id,
      {
        ...plan.previous!,
        summary: "已完成：电影 A 已下载。",
      },
    );

    const context = conversations.modelHistory(conversationId);
    expect(context.messages.map((message) => message.content)).toEqual([
      "接下来讨论电影 B",
    ]);
    expect(context.memory).toContain("电影 A");
    expect(context.memory).toContain("已下载");
    expect(conversations.history(conversationId)).toHaveLength(3);
    conversations.reset({
      userId: user.id,
      channel: "wechat",
      providerInstanceId: "wechat-main",
      externalConversationId: "memory@wechat",
    });
    expect(conversations.modelHistory(conversationId)).toEqual({
      messages: [],
      memory: "",
    });
    database.close();
  });

  it("keeps raw messages while using a persistent compacted model view", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "autofilm-conversation-"),
    );
    directories.push(directory);
    const database = openDatabase(path.join(directory, "test.sqlite"));
    const users = new UserStore(database);
    const conversations = new ConversationStore(database);
    const user = users.create({
      username: "compact-member",
      displayName: "Compact Member",
      role: "member",
    });
    const identity = {
      userId: user.id,
      channel: "wechat",
      providerInstanceId: "wechat-main",
      externalConversationId: "compact@wechat",
    };
    const conversationId = conversations.getOrCreate(identity);
    conversations.append(conversationId, {
      role: "user",
      content: "升级电影 A，并在成功后放置字幕。",
    });
    conversations.append(conversationId, {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-upgrade",
        name: "start_media_upgrades",
        arguments: { id: "upgrade-one" },
      }],
    });
    const last = conversations.append(conversationId, {
      role: "tool",
      toolCallId: "call-upgrade",
      content: JSON.stringify({ state: "running", id: "upgrade-one" }),
    });

    conversations.saveCompaction({
      conversationId,
      throughSequence: last.sequence,
      summary: "当前目标：升级电影 A。关键状态：upgrade-one 正在运行。",
      retainedUserMessages: ["升级电影 A，并在成功后放置字幕。"],
      sourceTokenEstimate: 200,
      summaryTokenEstimate: 40,
      compactionCount: 1,
    });
    conversations.append(conversationId, {
      role: "assistant",
      content: "升级完成后继续。",
    });

    const model = conversations.modelHistory(conversationId, {
      toolOutputTokenLimit: 1_000,
    });
    expect(model.messages).toHaveLength(2);
    expect(model.messages[0]?.content).toContain("upgrade-one 正在运行");
    expect(model.messages[0]?.content).toContain(
      "升级电影 A，并在成功后放置字幕。",
    );
    expect(model.messages[1]?.content).toBe("升级完成后继续。");
    expect(conversations.history(conversationId)).toHaveLength(4);

    conversations.reset(identity);
    expect(conversations.modelHistory(conversationId).messages).toEqual([]);
    database.close();
  });
});
