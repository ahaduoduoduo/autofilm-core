import type {
  WorkspacePlacementMapping,
  WorkspacePlacementPlan,
} from "../../subtitles/types.js";
import { resolveSubtitleReference } from "../../subtitles/references.js";
import type { AgentTool, ToolDependencies } from "../tool-types.js";
import { executePlacementMappings } from "./subtitle-placement-executor.js";
import {
  objectSchema,
  requireArray,
  requireString,
  stringProperty,
} from "./schema.js";

export function createSubtitlePlacementTools(
  deps: ToolDependencies,
): AgentTool[] {
  return [
    {
      definition: {
        name: "prepare_subtitle_placements",
        description:
          "校验字幕文件 UUID 与 Jellyfin Movie/Episode 的配对，生成不可修改的放置计划并返回最终映射表。此步骤不上传字幕。",
        parameters: objectSchema(
          {
            workspace_id: stringProperty("字幕工作区 ID"),
            mappings: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: {
                type: "object",
                properties: {
                  workspace_file_id: stringProperty(
                    "get_subtitle_workspace 返回的不可变字幕文件 UUID",
                  ),
                  jellyfin_item_id: stringProperty(
                    "Jellyfin Movie 或 Episode 条目 ID",
                  ),
                  replace_subtitle_ref: stringProperty(
                    "可选：list_jellyfin_subtitle_targets 返回的旧字幕引用",
                  ),
                  allow_file_reuse: {
                    type: "boolean",
                    description:
                      "同一字幕文件确需用于多个条目时，每个相关映射都必须显式设为 true",
                  },
                },
                required: ["workspace_file_id", "jellyfin_item_id"],
                additionalProperties: false,
              },
            },
          },
          ["workspace_id", "mappings"],
        ),
      },
      execute: async (args) =>
        preparePlacementPlan(
          deps,
          requireString(args, "workspace_id"),
          requireArray(args, "mappings"),
        ),
    },
    {
      definition: {
        name: "place_subtitles",
        description:
          "执行 prepare_subtitle_placements 生成的不可变计划。文本字幕逐文件独立清理，SUP/PGS 原样上传；失败项保留并可用同一计划重试，已经上传成功的项不会重复上传。",
        parameters: objectSchema(
          {
            workspace_id: stringProperty("字幕工作区 ID"),
            placement_plan_id: stringProperty("不可变字幕放置计划 ID"),
          },
          ["workspace_id", "placement_plan_id"],
        ),
      },
      execute: async (args) =>
        placeSubtitles(
          deps,
          requireString(args, "workspace_id"),
          requireString(args, "placement_plan_id"),
        ),
    },
    {
      definition: {
        name: "delete_jellyfin_subtitles",
        description:
          "按不可变字幕引用批量删除 Jellyfin 外挂字幕。删除前重新核对字幕文件摘要；引用失效时拒绝猜测当前流序号。",
        parameters: objectSchema(
          {
            targets: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: {
                type: "object",
                properties: {
                  jellyfin_item_id: stringProperty("Movie 或 Episode 条目 ID"),
                  subtitle_ref: stringProperty(
                    "list_jellyfin_subtitle_targets 返回的字幕引用",
                  ),
                },
                required: ["jellyfin_item_id", "subtitle_ref"],
                additionalProperties: false,
              },
            },
          },
          ["targets"],
        ),
      },
      execute: async (args) =>
        deleteSubtitles(deps, requireArray(args, "targets")),
    },
  ];
}

async function preparePlacementPlan(
  deps: ToolDependencies,
  workspaceId: string,
  values: unknown[],
): Promise<Record<string, unknown>> {
  if (values.length > 100) throw new Error("单次最多添加 100 个字幕");
  deps.subtitleWorkspaces.require(deps.userId, workspaceId);
  const inputs = values.map((value, mappingIndex) => {
    if (!value || typeof value !== "object") {
      throw new Error(`第 ${mappingIndex + 1} 项映射格式无效`);
    }
    const mapping = value as Record<string, unknown>;
    return {
      fileId: requireString(mapping, "workspace_file_id"),
      itemId: requireString(mapping, "jellyfin_item_id"),
      replacementSubtitleRef:
        typeof mapping.replace_subtitle_ref === "string" &&
        mapping.replace_subtitle_ref
          ? mapping.replace_subtitle_ref
          : undefined,
      allowFileReuse: mapping.allow_file_reuse === true,
    };
  });
  const pairs = new Set<string>();
  const fileUseCount = new Map<string, number>();
  for (const input of inputs) {
    const pair = `${input.fileId}\u0000${input.itemId}`;
    if (pairs.has(pair)) {
      throw new Error("放置计划包含完全重复的字幕文件与 Jellyfin 条目配对");
    }
    pairs.add(pair);
    fileUseCount.set(input.fileId, (fileUseCount.get(input.fileId) ?? 0) + 1);
  }
  for (const input of inputs) {
    if ((fileUseCount.get(input.fileId) ?? 0) > 1 && !input.allowFileReuse) {
      throw new Error(
        `字幕文件 ${input.fileId} 被用于多个条目；所有相关映射都必须显式设置 allow_file_reuse=true`,
      );
    }
  }

  const mappings: Array<Omit<WorkspacePlacementMapping, "id">> = [];
  for (const input of inputs) {
    const source = deps.subtitleWorkspaces.fileById(
      deps.userId,
      workspaceId,
      input.fileId,
    );
    const item = await deps.jellyfin.item(input.itemId);
    if (item.Type !== "Movie" && item.Type !== "Episode") {
      throw new Error(
        `Jellyfin 条目 ${item.Id} 是 ${item.Type}，字幕只能添加到 Movie 或 Episode`,
      );
    }
    if (input.replacementSubtitleRef) {
      resolveSubtitleReference(item, input.replacementSubtitleRef);
    }
    mappings.push({
      fileId: source.id,
      fileName: source.filename,
      relativePath: source.relativePath,
      format: source.format,
      languageHint: source.languageHint,
      episodeHint: source.episodeHint,
      fileDigest: await deps.subtitleWorkspaces.fileDigestById(
        deps.userId,
        workspaceId,
        input.fileId,
      ),
      itemId: item.Id,
      itemName: item.Name,
      itemType: item.Type,
      itemSource: item.Path?.startsWith("openlist:///")
        ? "openlist"
        : "local",
      season: item.ParentIndexNumber,
      episode: item.IndexNumber,
      replacementSubtitleRef: input.replacementSubtitleRef,
      allowFileReuse: input.allowFileReuse,
    });
  }
  const plan = deps.subtitleWorkspaces.createPlacementPlan({
    userId: deps.userId,
    workspaceId,
    mappings,
  });
  return placementPlanView(workspaceId, plan);
}

async function placeSubtitles(
  deps: ToolDependencies,
  workspaceId: string,
  planId: string,
): Promise<Record<string, unknown>> {
  const plan = deps.subtitleWorkspaces.beginPlacementPlan(
    deps.userId,
    workspaceId,
    planId,
  );
  const results: Array<Record<string, unknown>> = [];
  try {
    results.push(
      ...(await executePlacementMappings(
        deps,
        workspaceId,
        planId,
        plan.mappings,
      )),
    );
  } finally {
    deps.subtitleWorkspaces.finishPlacementPlan(
      deps.userId,
      workspaceId,
      planId,
    );
  }

  const current = deps.subtitleWorkspaces.placementPlan(
    deps.userId,
    workspaceId,
    planId,
  );
  const failed = current.mappings.filter((mapping) => !mapping.completedAt);
  const succeeded = current.mappings.length - failed.length;
  const response = {
    workspaceId,
    placementPlanId: planId,
    status:
      failed.length === 0
        ? "success"
        : succeeded === 0
          ? "failed"
          : "partial",
    succeeded,
    failed: failed.length,
    workspaceRetained: failed.length > 0,
    results,
  };
  if (failed.length === 0) deps.subtitleWorkspaces.remove(workspaceId);
  return response;
}

async function deleteSubtitles(
  deps: ToolDependencies,
  targets: unknown[],
): Promise<Record<string, unknown>> {
  if (targets.length > 100) throw new Error("单次最多删除 100 个字幕");
  const results: Array<Record<string, unknown>> = [];
  for (const value of targets) {
    if (!value || typeof value !== "object") {
      results.push({ ok: false, error: "目标格式无效" });
      continue;
    }
    const target = value as Record<string, unknown>;
    try {
      const itemId = requireString(target, "jellyfin_item_id");
      const reference = requireString(target, "subtitle_ref");
      const item = await deps.jellyfin.item(itemId);
      const resolved = resolveSubtitleReference(item, reference);
      await deps.jellyfin.deleteSubtitle(itemId, resolved.index);
      results.push({
        ok: true,
        itemId,
        subtitleRef: reference,
      });
    } catch (error) {
      results.push({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    succeeded: results.filter((result) => result.ok === true).length,
    failed: results.filter((result) => result.ok !== true).length,
    results,
  };
}

function placementPlanView(
  workspaceId: string,
  plan: WorkspacePlacementPlan,
): Record<string, unknown> {
  return {
    workspaceId,
    placementPlanId: plan.id,
    immutable: true,
    createdAt: plan.createdAt,
    mappings: plan.mappings.map((mapping) => ({
      mappingId: mapping.id,
      workspaceFileId: mapping.fileId,
      fileName: mapping.fileName,
      relativePath: mapping.relativePath,
      format: mapping.format,
      language: mapping.languageHint,
      episodeHint: mapping.episodeHint,
      jellyfinItemId: mapping.itemId,
      jellyfinName: mapping.itemName,
      type: mapping.itemType,
      source: mapping.itemSource,
      season: mapping.season,
      episode: mapping.episode,
      replacementSubtitleRef: mapping.replacementSubtitleRef,
      allowFileReuse: mapping.allowFileReuse,
    })),
    instruction:
      "核对最终映射表；确认无误后只使用 workspace_id 和 placement_plan_id 调用 place_subtitles。",
  };
}
