import type { UpgradeCheckResolution } from "../../db/media-upgrade-check-store.js";
import { JellyfinMovieInventory } from "../media-inventory.js";
import type { AgentTool, ToolDependencies } from "../tool-types.js";
import {
  objectSchema,
  requireArray,
  requireNumber,
  requireString,
  stringProperty,
} from "./schema.js";

const MAX_TARGETS = 1_000;
const RESOLUTIONS = ["1080p", "2160p", "4320p"] as const;
const SOURCE_RESOLUTIONS = [
  "sd",
  "720p",
  "1080p",
  "1440p",
  "2160p",
  "4320p",
  "unknown",
] as const;

export function createMediaUpgradeCheckTools(
  deps: ToolDependencies,
): AgentTool[] {
  return [
    {
      definition: {
        name: "list_jellyfin_upgrade_check_targets",
        description:
          "按当前分辨率分页生成批量升级检查所需的紧凑电影列表。每页最多 100 项；返回的 targets 可合并后原样提交给 start_bulk_media_upgrade_check。",
        parameters: objectSchema(
          {
            resolution: {
              type: "string",
              enum: SOURCE_RESOLUTIONS,
              description: "要检查的现有电影分辨率",
            },
            page: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          ["resolution"],
        ),
      },
      execute: async (args) => {
        const sourceResolution = sourceResolutionValue(args.resolution);
        const page = integer(args, "page", 0, 0, 100_000);
        const limit = integer(args, "limit", 100, 1, 100);
        const all = (await new JellyfinMovieInventory(deps.jellyfin).versions())
          .filter((version) => version.resolution === sourceResolution)
          .sort(
            (left, right) =>
              left.name.localeCompare(right.name, "zh-CN") ||
              (left.productionYear ?? 0) - (right.productionYear ?? 0),
          );
        const start = page * limit;
        const targets = all.slice(start, start + limit).map((version) => ({
          jellyfin_item_id: version.jellyfinItemId,
          title: version.name,
          original_title: version.originalTitle,
          production_year: version.productionYear,
          current_resolution: version.resolution,
        }));
        return {
          resolution: sourceResolution,
          page,
          limit,
          total: all.length,
          hasMore: start + targets.length < all.length,
          nextPage:
            start + targets.length < all.length ? page + 1 : undefined,
          targets,
        };
      },
    },
    {
      definition: {
        name: "start_bulk_media_upgrade_check",
        description:
          "提交大量 Jellyfin 电影版本的后台画质升级检查。Core 自行构造搜索词并以 8 并发查询；工具立即返回任务 ID，不返回逐片搜索结果。",
        parameters: objectSchema(
          {
            target_resolution: {
              type: "string",
              enum: RESOLUTIONS,
              description: "要检查是否存在的目标分辨率",
            },
            targets: {
              type: "array",
              minItems: 1,
              maxItems: MAX_TARGETS,
              items: {
                type: "object",
                properties: {
                  jellyfin_item_id: stringProperty(
                    "query_jellyfin_movies 返回的电影版本 ID",
                  ),
                  title: stringProperty("Jellyfin 中文或显示标题"),
                  original_title: stringProperty("可选原始标题"),
                  production_year: {
                    type: "integer",
                    minimum: 1880,
                    maximum: 2200,
                  },
                  current_resolution: stringProperty("当前实际分辨率类别"),
                },
                required: [
                  "jellyfin_item_id",
                  "title",
                  "current_resolution",
                ],
                additionalProperties: false,
              },
            },
          },
          ["target_resolution", "targets"],
        ),
      },
      execute: async (args) => {
        const targetResolution = resolution(args.target_resolution);
        const targets = parseTargets(requireArray(args, "targets"));
        const job = deps.mediaUpgradeChecks.create({
          userId: deps.userId,
          targetResolution,
          notificationTarget: deps.notificationTarget,
          targets,
        });
        return {
          jobId: job.id,
          state: job.state,
          targetResolution,
          total: targets.length,
          concurrency: 8,
          background: true,
          message:
            "检查已进入后台。完成后 Core 会在当前聊天通知；未命中的片名不会传给模型。",
        };
      },
    },
    {
      definition: {
        name: "get_bulk_media_upgrade_check_results",
        description:
          "分页读取批量升级检查状态和命中项。只返回存在目标分辨率资源的电影；未命中电影仅计数，不进入模型上下文。",
        parameters: objectSchema(
          {
            job_id: stringProperty("批量升级检查任务 ID"),
            page: {
              type: "integer",
              minimum: 0,
              description: "命中结果页码，从 0 开始",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 10,
              description: "每页命中电影数量，默认和最大均为 10",
            },
          },
          ["job_id"],
        ),
      },
      execute: async (args) => {
        const jobId = requireString(args, "job_id");
        const page = integer(args, "page", 0, 0, 100_000);
        const limit = integer(args, "limit", 10, 1, 10);
        const summary = deps.mediaUpgradeChecks.summary(jobId, deps.userId);
        const results = deps.mediaUpgradeChecks.matchedResults({
          jobId,
          userId: deps.userId,
          page,
          limit,
        });
        if (!summary || !results) throw new Error("批量升级检查任务不存在");
        const start = page * limit;
        return {
          ...summary,
          page,
          limit,
          totalMatched: results.total,
          hasMore: start + results.items.length < results.total,
          nextPage:
            start + results.items.length < results.total
              ? page + 1
              : undefined,
          matches: results.items.map((item) => ({
            upgradeCheckItemId: item.id,
            jellyfinItemId: item.jellyfinItemId,
            title: item.title,
            originalTitle: item.originalTitle || undefined,
            productionYear: item.productionYear,
            currentResolution: item.currentResolution,
            targetResolution: summary.targetResolution,
            candidateCount: item.candidateCount,
            sampleCandidates: item.candidates.slice(0, 3),
          })),
          resultPolicy:
            "每个命中项仅展示按大小排序的前三个样例；决定升级某部电影后，使用标准资源升级搜索重新获取完整候选。",
        };
      },
    },
  ];
}

function parseTargets(values: unknown[]) {
  if (values.length > MAX_TARGETS) {
    throw new Error(`单个检查任务最多包含 ${MAX_TARGETS} 个电影版本`);
  }
  const ids = new Set<string>();
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`targets[${index}] 必须是对象`);
    }
    const target = value as Record<string, unknown>;
    const jellyfinItemId = requireString(target, "jellyfin_item_id");
    if (!ids.add(jellyfinItemId)) {
      throw new Error("同一个 Jellyfin 电影版本不能重复检查");
    }
    const productionYear =
      target.production_year === undefined
        ? undefined
        : requireNumber(target, "production_year");
    if (
      productionYear !== undefined &&
      (!Number.isInteger(productionYear) ||
        productionYear < 1880 ||
        productionYear > 2200)
    ) {
      throw new Error(`targets[${index}].production_year 无效`);
    }
    return {
      jellyfinItemId,
      title: requireString(target, "title"),
      originalTitle:
        typeof target.original_title === "string" &&
        target.original_title.trim()
          ? target.original_title.trim()
          : undefined,
      productionYear,
      currentResolution: requireString(target, "current_resolution"),
    };
  });
}

function resolution(value: unknown): UpgradeCheckResolution {
  if (
    typeof value !== "string" ||
    !(RESOLUTIONS as readonly string[]).includes(value)
  ) {
    throw new Error(`不支持的目标分辨率：${String(value)}`);
  }
  return value as UpgradeCheckResolution;
}

function sourceResolutionValue(
  value: unknown,
): (typeof SOURCE_RESOLUTIONS)[number] {
  if (
    typeof value !== "string" ||
    !(SOURCE_RESOLUTIONS as readonly string[]).includes(value)
  ) {
    throw new Error(`不支持的现有分辨率：${String(value)}`);
  }
  return value as (typeof SOURCE_RESOLUTIONS)[number];
}

function integer(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (args[key] === undefined) return fallback;
  const value = requireNumber(args, key);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}
