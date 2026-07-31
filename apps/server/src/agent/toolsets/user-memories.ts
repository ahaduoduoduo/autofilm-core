import type {
  UserMemoryCategory,
} from "../../db/user-memory-store.js";
import type { AgentTool, ToolDependencies } from "../tool-types.js";
import {
  objectSchema,
  requireString,
  stringProperty,
} from "./schema.js";

const CATEGORIES = [
  "preference",
  "profile",
  "constraint",
  "note",
] as const satisfies readonly UserMemoryCategory[];

export function createUserMemoryTools(deps: ToolDependencies): AgentTool[] {
  return [
    {
      definition: {
        name: "list_user_memories",
        description:
          "列出当前成员跨会话保留的长期记忆及 memory_id。修改已有偏好前使用。",
        parameters: objectSchema({}),
      },
      execute: async () => ({ memories: deps.userMemories.list(deps.userId) }),
    },
    {
      definition: {
        name: "add_user_memory",
        description:
          "仅在当前成员明确要求记住偏好、限制或个人信息时新增长期记忆。/new 和 /clear 不会删除它。",
        parameters: objectSchema(
          {
            category: {
              type: "string",
              enum: CATEGORIES,
              description: "preference、profile、constraint 或 note",
            },
            content: stringProperty("独立、明确、以后仍有用的记忆内容"),
          },
          ["category", "content"],
        ),
      },
      execute: async (args) =>
        deps.userMemories.add({
          userId: deps.userId,
          category: category(args.category),
          content: requireString(args, "content"),
        }),
    },
    {
      definition: {
        name: "update_user_memory",
        description:
          "修改当前成员已有长期记忆。memory_id 必须来自系统上下文或 list_user_memories。",
        parameters: objectSchema(
          {
            memory_id: stringProperty("要修改的长期记忆 ID"),
            category: {
              type: "string",
              enum: CATEGORIES,
              description: "可选的新分类",
            },
            content: stringProperty("修改后的完整记忆内容"),
          },
          ["memory_id", "content"],
        ),
      },
      execute: async (args) =>
        deps.userMemories.update({
          userId: deps.userId,
          id: requireString(args, "memory_id"),
          category:
            args.category === undefined ? undefined : category(args.category),
          content: requireString(args, "content"),
        }),
    },
    {
      definition: {
        name: "delete_user_memory",
        description:
          "仅在当前成员明确要求忘记某条长期记忆时删除。不能用它清理普通聊天记录。",
        parameters: objectSchema(
          { memory_id: stringProperty("要删除的长期记忆 ID") },
          ["memory_id"],
        ),
      },
      execute: async (args) => {
        const id = requireString(args, "memory_id");
        const deleted = deps.userMemories.delete(deps.userId, id);
        if (!deleted) throw new Error("长期记忆不存在");
        return { deleted: true, memoryId: id };
      },
    },
  ];
}

function category(value: unknown): UserMemoryCategory {
  if (
    typeof value !== "string" ||
    !(CATEGORIES as readonly string[]).includes(value)
  ) {
    throw new Error(`不支持的长期记忆分类：${String(value)}`);
  }
  return value as UserMemoryCategory;
}
