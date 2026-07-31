import { createHash } from "node:crypto";
import path from "node:path";
import type {
  MediaUpgradeCandidate,
  MediaUpgradeItem,
} from "../../db/media-upgrade-store.js";
import type { AgentTool, ToolDependencies } from "../tool-types.js";
import {
  objectSchema,
  requireArray,
  requireString,
  stringProperty,
} from "./schema.js";
import {
  effectiveOriginalOpenListPath,
  currentMediaSize,
  hasVideoStream,
  isLikelySameMediaRelease,
  moveOpenListObjectIdempotently,
  openListPathFromUri,
  toOpenListUri,
} from "../../tasks/media-upgrade-files.js";
import {
  uniqueDownloadCandidates,
  type DownloadCandidate,
} from "../../tasks/download-candidates.js";

const MAX_TARGETS = 8;
const SEARCH_CONCURRENCY = 4;
const DOWNLOAD_CONCURRENCY = 4;

export function createMediaUpgradeTools(deps: ToolDependencies): AgentTool[] {
  return [
    {
      definition: {
        name: "search_media_upgrade_candidates",
        description:
          "为一部或多部现有 Jellyfin 电影/单集并发搜索替换资源。每个目标独立保存，返回稳定的 upgrade_item_id 和 release_candidate_id。",
        parameters: objectSchema(
          {
            targets: {
              type: "array",
              minItems: 1,
              maxItems: MAX_TARGETS,
              items: {
                type: "object",
                properties: {
                  jellyfin_item_id: stringProperty("现有 Movie 或 Episode ID"),
                  query: stringProperty(
                    "可选 Jackett 搜索词；不传时使用原始标题和年份",
                  ),
                },
                required: ["jellyfin_item_id"],
                additionalProperties: false,
              },
            },
          },
          ["targets"],
        ),
      },
      execute: async (args) => {
        const targets = parseTargets(requireArray(args, "targets"));
        const targetItems = await mapConcurrent(
          targets,
          SEARCH_CONCURRENCY,
          async (target) => {
            const item = await deps.jellyfin.item(target.jellyfinItemId);
            if (!["Movie", "Episode"].includes(item.Type)) {
              throw new Error(`${item.Name} 不是可升级的 Movie 或 Episode`);
            }
            if (!item.Path?.startsWith("openlist:///")) {
              throw new Error(`${item.Name} 当前不是 OpenList 远端视频`);
            }
            return { target, item };
          },
        );
        const jobId = deps.mediaUpgrades.createJob(deps.userId);
        const items: MediaUpgradeItem[] = [];
        for (const { target, item } of targetItems) {
          const query =
            target.query ||
            [item.OriginalTitle || item.Name, item.ProductionYear]
              .filter(Boolean)
              .join(" ");
          items.push(
            deps.mediaUpgrades.createItem({
              jobId,
              jellyfinItemId: item.Id,
              title: item.Name,
              query,
              current: {
                path: item.Path,
                type: item.Type,
                originalTitle: item.OriginalTitle,
                productionYear: item.ProductionYear,
                providerIds: item.ProviderIds,
                season: item.ParentIndexNumber,
                episode: item.IndexNumber,
                mediaSources: item.MediaSources,
                mediaStreams: item.MediaStreams,
              },
            }),
          );
        }

        await mapConcurrent(items, SEARCH_CONCURRENCY, async (item) => {
          try {
            const releases = await deps.jackett.searchAll(item.query);
            const candidates = new Map<string, MediaUpgradeCandidate>();
            for (const release of releases) {
              if (!release.downloadUrl) continue;
              const id = candidateId(item.id, release.downloadUrl);
              if (candidates.has(id)) continue;
              candidates.set(id, {
                id,
                title: release.title,
                downloadUrl: release.downloadUrl,
                size: release.size,
                seeders: release.seeders,
                peers: release.peers,
                tracker: release.tracker,
                publishDate: release.publishDate,
              });
            }
            deps.mediaUpgrades.update(item.id, {
              state: "awaiting_selection",
              candidates: [...candidates.values()],
              error: "",
            });
          } catch (error) {
            deps.mediaUpgrades.update(item.id, {
              state: "search_failed",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        return jobResult(deps, jobId);
      },
    },
    {
      definition: {
        name: "start_media_upgrades",
        description:
          "用户确认候选资源后，为多个升级项并发创建相互隔离的 OpenList 离线提交任务。返回结果不表示 115 已接受或下载完成；每个选择必须使用稳定ID，任一项失败不影响其他项。",
        parameters: objectSchema(
          {
            selections: {
              type: "array",
              minItems: 1,
              maxItems: MAX_TARGETS,
              items: {
                type: "object",
                properties: {
                  upgrade_item_id: stringProperty("升级子任务ID"),
                  release_candidate_id: stringProperty("已确认的候选资源ID"),
                  fallback_candidate_ids: {
                    type: "array",
                    maxItems: 8,
                    items: { type: "string" },
                    description: "可选备用候选ID，失败后只供用户重新选择",
                  },
                },
                required: ["upgrade_item_id", "release_candidate_id"],
                additionalProperties: false,
              },
            },
          },
          ["selections"],
        ),
      },
      execute: async (args) => {
        const selections = parseSelections(requireArray(args, "selections"));
        const results = await mapConcurrent(
          selections,
          DOWNLOAD_CONCURRENCY,
          async (selection) => {
            try {
              return {
                ok: true,
                result: await startUpgradeDownload(deps, selection),
              };
            } catch (error) {
              return {
                ok: false,
                upgradeItemId: selection.itemId,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        );
        return {
          submitted: results.filter((result) => result.ok).length,
          failed: results.filter((result) => !result.ok).length,
          items: results,
        };
      },
    },
    {
      definition: {
        name: "get_media_upgrade_job",
        description:
          "读取资源升级任务中每个影视的独立状态、候选、下载、替换和旧文件备份结果。",
        parameters: objectSchema(
          { job_id: stringProperty("升级任务ID") },
          ["job_id"],
        ),
      },
      execute: async (args) => {
        const jobId = requireString(args, "job_id");
        if (deps.mediaUpgrades.jobOwner(jobId) !== deps.userId) {
          throw new Error("资源升级任务不存在");
        }
        return jobResult(deps, jobId);
      },
    },
    {
      definition: {
        name: "rollback_media_upgrades",
        description:
          "在用户明确确认后，把一个或多个已成功升级的条目恢复为备份旧文件；每项独立执行。",
        parameters: objectSchema(
          {
            upgrade_item_ids: {
              type: "array",
              minItems: 1,
              maxItems: MAX_TARGETS,
              items: { type: "string" },
              description: "get_media_upgrade_job 返回的升级子任务ID",
            },
          },
          ["upgrade_item_ids"],
        ),
      },
      execute: async (args) => {
        const ids = [
          ...new Set(
            requireArray(args, "upgrade_item_ids").map((value) =>
              String(value),
            ),
          ),
        ];
        if (ids.length === 0 || ids.length > MAX_TARGETS) {
          throw new Error(`一次最多恢复 ${MAX_TARGETS} 个升级项`);
        }
        const results = await mapConcurrent(
          ids,
          DOWNLOAD_CONCURRENCY,
          async (id) => {
            try {
              return {
                ok: true,
                result: await rollbackUpgrade(deps, id),
              };
            } catch (error) {
              return {
                ok: false,
                upgradeItemId: id,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        );
        return {
          restored: results.filter((result) => result.ok).length,
          failed: results.filter((result) => !result.ok).length,
          items: results,
        };
      },
    },
  ];
}

async function rollbackUpgrade(
  deps: ToolDependencies,
  itemId: string,
): Promise<unknown> {
  const item = deps.mediaUpgrades.get(itemId);
  if (
    !item ||
    deps.mediaUpgrades.jobOwner(item.jobId) !== deps.userId ||
    item.state !== "succeeded"
  ) {
    throw new Error("可恢复的升级子任务不存在");
  }
  if (!item.backupPath || !item.newPath) {
    throw new Error(`${item.title} 没有完整的旧文件备份记录`);
  }
  const originalPath = effectiveOriginalOpenListPath(item.current);
  const expectedNewUri = toOpenListUri(item.newPath);
  const current = await deps.jellyfin.item(item.jellyfinItemId);
  if (current.Path !== expectedNewUri) {
    throw new Error(`${item.title} 的 Jellyfin 媒体路径已经变化`);
  }

  const restoredFile = await moveOpenListObjectIdempotently(deps.openList, {
    sourcePath: item.backupPath,
    destinationDirectory: path.posix.dirname(originalPath),
    destinationName: path.posix.basename(originalPath),
    expectedSize: currentMediaSize(item.current),
  });
  try {
    let restoredByToken = false;
    if (item.rollbackToken) {
      try {
        await deps.jellyfin.rollbackReplacement(item.rollbackToken);
        restoredByToken = true;
      } catch {
        const afterToken = await deps.jellyfin.item(item.jellyfinItemId);
        restoredByToken = afterToken.Path === toOpenListUri(originalPath);
      }
    }
    if (!restoredByToken) {
      const preview = await deps.jellyfin.previewReplacement(
        item.jellyfinItemId,
        originalPath,
      );
      try {
        await deps.jellyfin.applyReplacement(preview.previewToken);
      } catch (error) {
        const afterApply = await deps.jellyfin.item(item.jellyfinItemId);
        if (
          afterApply.Path !== toOpenListUri(originalPath) ||
          !hasVideoStream(afterApply)
        ) {
          throw error;
        }
      }
    }
    const verified = await deps.jellyfin.item(item.jellyfinItemId);
    if (
      verified.Path !== toOpenListUri(originalPath) ||
      !hasVideoStream(verified)
    ) {
      throw new Error("Jellyfin 没有恢复到旧媒体路径和视频流");
    }

    const backupDirectory = `/115/autofilm-backups/upgrades/${item.id}`;
    await deps.openList.mkdir(backupDirectory);
    const archivedReplacement = await moveOpenListObjectIdempotently(
      deps.openList,
      {
        sourcePath: item.newPath,
        destinationDirectory: backupDirectory,
      },
    );
    deps.mediaUpgrades.update(item.id, {
      state: "rolled_back",
      backupPath: archivedReplacement.path,
      rollbackToken: null,
      error: "",
    });
    return {
      jobId: item.jobId,
      upgradeItemId: item.id,
      title: item.title,
      state: "rolled_back",
      currentPath: restoredFile.path,
      archivedReplacementPath: archivedReplacement.path,
    };
  } catch (error) {
    deps.mediaUpgrades.update(item.id, {
      error:
        "旧文件已恢复到原目录，但 Jellyfin 恢复未完成：" +
        (error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
}

async function startUpgradeDownload(
  deps: ToolDependencies,
  selection: {
    itemId: string;
    candidateId: string;
    fallbackCandidateIds: string[];
  },
): Promise<unknown> {
  const item = deps.mediaUpgrades.get(selection.itemId);
  if (!item || deps.mediaUpgrades.jobOwner(item.jobId) !== deps.userId) {
    throw new Error("升级子任务不存在");
  }
  if (item.state !== "awaiting_selection") {
    throw new Error(`${item.title} 当前不能选择资源`);
  }
  const selected = requireCandidate(item, selection.candidateId);
  if (
    isLikelySameMediaRelease({
      currentPath: openListPathFromUri(item.current.path),
      currentSize: currentMediaSize(item.current),
      candidateName: selected.title,
      candidateSize: selected.size,
    })
  ) {
    throw new Error(
      `${item.title} 所选资源与当前视频是相同发布版本和相同大小，不属于资源升级`,
    );
  }
  const fallbacks = selection.fallbackCandidateIds.map((id) =>
    requireCandidate(item, id),
  );
  const resolved = await resolveUpgradeCandidates(
    deps,
    selected,
    fallbacks,
  );
  const primary = resolved.candidates[0]!;
  const stagingPath = `/115/autofilm-staging/upgrades/${item.id}`;
  await deps.openList.mkdir(stagingPath);
  const remoteTasks = await deps.openList.startOfflineDownload({
    path: stagingPath,
    url: primary.magnetUri,
  });
  const policy = deps.openList.instantOfflinePolicy();
  const metadata = {
    destination: stagingPath,
    sourceCandidateId: primary.id,
    downloadCandidates: resolved.candidates,
    attemptIndex: 0,
    attemptQueuedAt: new Date().toISOString(),
    instantOfflinePolicy: policy,
    notificationTarget: deps.notificationTarget,
    mediaUpgrade: {
      jobId: item.jobId,
      upgradeItemId: item.id,
      jellyfinItemId: item.jellyfinItemId,
      stagingPath,
    },
  };
  const remote = remoteTasks[0];
  const task = deps.tasks.create({
    userId: deps.userId,
    type: "offline-download",
    title: `升级 ${item.title}`,
    state: remote ? "running" : "waiting",
    externalId: remote?.id,
    metadata: {
      ...metadata,
      remoteName: remote?.name,
      openListTaskId: remote?.id,
    },
  });
  deps.mediaUpgrades.update(item.id, {
    state: remote ? "downloading" : "awaiting_alternative",
    selectedCandidateId: selected.id,
    downloadTaskId: task.id,
    error: remote ? "" : "OpenList 没有返回离线任务",
  });
  return {
    jobId: item.jobId,
    upgradeItemId: item.id,
    title: item.title,
    state: remote ? "submitting" : "awaiting_alternative",
    downloadTaskId: task.id,
    stagingPath,
    unavailableFallbacks: resolved.unavailableFallbacks,
  };
}

function jobResult(deps: ToolDependencies, jobId: string) {
  const items = deps.mediaUpgrades.items(jobId);
  return {
    jobId,
    total: items.length,
    states: Object.fromEntries(
      [...new Set(items.map((item) => item.state))].map((state) => [
        state,
        items.filter((item) => item.state === state).length,
      ]),
    ),
    items: items.map((item) => ({
      ...item,
      candidates: item.candidates.slice(0, 20).map(
        ({ downloadUrl: _downloadUrl, ...candidate }) => ({
          ...candidate,
          sameAsCurrent: isLikelySameMediaRelease({
            currentPath: openListPathFromUri(item.current.path),
            currentSize: currentMediaSize(item.current),
            candidateName: candidate.title,
            candidateSize: candidate.size,
          }),
        }),
      ),
      candidateCount: item.candidates.length,
    })),
  };
}

async function resolveUpgradeCandidates(
  deps: ToolDependencies,
  selected: MediaUpgradeCandidate,
  fallbacks: MediaUpgradeCandidate[],
): Promise<{
  candidates: DownloadCandidate[];
  unavailableFallbacks: Array<{
    candidateId: string;
    title: string;
    error: string;
  }>;
}> {
  const releases = [selected, ...fallbacks];
  const results = await Promise.allSettled(
    releases.map(async (candidate) => ({
      id: candidate.id,
      title: candidate.title,
      magnetUri: await deps.jackett.resolveDownloadUrl(
        candidate.downloadUrl,
        candidate.title,
      ),
    })),
  );
  const primary = results[0];
  if (!primary || primary.status === "rejected") {
    throw new Error(
      `所选资源无法转换为磁力链接：${
        primary?.status === "rejected"
          ? errorMessage(primary.reason)
          : "解析结果为空"
      }`,
    );
  }
  const candidates = [primary.value];
  const unavailableFallbacks: Array<{
    candidateId: string;
    title: string;
    error: string;
  }> = [];
  for (const [index, result] of results.slice(1).entries()) {
    if (result.status === "fulfilled") {
      candidates.push(result.value);
    } else {
      const fallback = fallbacks[index]!;
      unavailableFallbacks.push({
        candidateId: fallback.id,
        title: fallback.title,
        error: errorMessage(result.reason),
      });
    }
  }
  return {
    candidates: uniqueDownloadCandidates(candidates),
    unavailableFallbacks,
  };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function requireCandidate(
  item: MediaUpgradeItem,
  id: string,
): MediaUpgradeCandidate {
  const candidate = item.candidates.find((value) => value.id === id);
  if (!candidate) {
    throw new Error(`${item.title} 的候选资源已失效`);
  }
  return candidate;
}

function candidateId(itemId: string, url: string): string {
  return createHash("sha256")
    .update(`${itemId}\n${url}`)
    .digest("base64url")
    .slice(0, 24);
}

function parseTargets(values: unknown[]) {
  const seen = new Set<string>();
  return values.map((value, index) => {
    const object = requireObject(value, `targets[${index}]`);
    const jellyfinItemId = requireString(object, "jellyfin_item_id");
    if (!seen.add(jellyfinItemId)) {
      throw new Error("同一个 Jellyfin 条目不能重复创建升级项");
    }
    return {
      jellyfinItemId,
      query:
        typeof object.query === "string" ? object.query.trim() : undefined,
    };
  });
}

function parseSelections(values: unknown[]) {
  const seen = new Set<string>();
  return values.map((value, index) => {
    const object = requireObject(value, `selections[${index}]`);
    const itemId = requireString(object, "upgrade_item_id");
    if (!seen.add(itemId)) {
      throw new Error("同一个升级子任务不能重复提交");
    }
    const fallbackIds = Array.isArray(object.fallback_candidate_ids)
      ? object.fallback_candidate_ids.map((id) => String(id))
      : [];
    return {
      itemId,
      candidateId: requireString(object, "release_candidate_id"),
      fallbackCandidateIds: fallbackIds,
    };
  });
}

function requireObject(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  execute: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await execute(values[index]!);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      () => worker(),
    ),
  );
  return results;
}
