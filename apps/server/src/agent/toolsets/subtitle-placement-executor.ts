import path from "node:path";
import { Readable } from "node:stream";
import type { WorkspacePlacementMapping } from "../../subtitles/types.js";
import { jellyfinLanguage } from "../../subtitles/hints.js";
import { resolveSubtitleReference } from "../../subtitles/references.js";
import type { ToolDependencies } from "../tool-types.js";

export const SUBTITLE_PLACEMENT_CONCURRENCY = 8;

export async function executePlacementMappings(
  deps: ToolDependencies,
  workspaceId: string,
  planId: string,
  mappings: readonly WorkspacePlacementMapping[],
): Promise<Array<Record<string, unknown>>> {
  const results = new Array<Record<string, unknown>>(mappings.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < mappings.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await executePlacementMapping(
        deps,
        workspaceId,
        planId,
        mappings[index]!,
      );
    }
  };

  const workers = Array.from(
    {
      length: Math.min(SUBTITLE_PLACEMENT_CONCURRENCY, mappings.length),
    },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function executePlacementMapping(
  deps: ToolDependencies,
  workspaceId: string,
  planId: string,
  mapping: WorkspacePlacementMapping,
): Promise<Record<string, unknown>> {
  if (mapping.completedAt) {
    return {
      mappingId: mapping.id,
      ok: true,
      alreadyCompleted: true,
      workspaceFileId: mapping.fileId,
      jellyfinItemId: mapping.itemId,
    };
  }

  let phase = "读取字幕工作区文件";
  try {
    const source = deps.subtitleWorkspaces.fileById(
      deps.userId,
      workspaceId,
      mapping.fileId,
    );
    if (
      await deps.subtitleWorkspaces.fileDigestById(
        deps.userId,
        workspaceId,
        mapping.fileId,
      ) !== mapping.fileDigest
    ) {
      throw new Error("字幕工作区文件内容已经变化，拒绝执行旧放置计划");
    }

    phase = "读取 Jellyfin 条目";
    let item = await deps.jellyfin.item(mapping.itemId);
    if (item.Type !== mapping.itemType) {
      throw new Error("Jellyfin 条目类型已经变化，拒绝执行旧放置计划");
    }
    if (mapping.replacementSubtitleRef && !mapping.uploadedAt) {
      resolveSubtitleReference(item, mapping.replacementSubtitleRef);
    }

    let cleaning: { removed: number; summary: string } | undefined;
    if (!mapping.uploadedAt) {
      const extension = path.extname(source.filename).toLowerCase();
      const isText = [".ass", ".ssa", ".srt", ".vtt"].includes(extension);
      let uploadStream: Readable;
      let contentLength: number;
      if (isText) {
        phase = "清理文本字幕";
        const buffered = deps.subtitleWorkspaces.readFileById(
          deps.userId,
          workspaceId,
          mapping.fileId,
        );
        const cleaned = await deps.subtitleCleaner.clean(
          buffered.metadata.filename,
          buffered.data,
        );
        uploadStream = Readable.from([cleaned.data]);
        contentLength = cleaned.data.byteLength;
        cleaning = {
          removed: cleaned.removed,
          summary: cleaned.summary,
        };
      } else {
        const opened = deps.subtitleWorkspaces.openFileById(
          deps.userId,
          workspaceId,
          mapping.fileId,
        );
        uploadStream = opened.stream;
        contentLength = opened.sizeBytes;
        cleaning = {
          removed: 0,
          summary: "SUP 或其他二进制字幕不执行广告清理",
        };
      }

      const lowerName = source.filename.toLowerCase();
      phase = "上传字幕到 Jellyfin";
      try {
        await deps.jellyfin.uploadSubtitle({
          itemId: mapping.itemId,
          format: mapping.format,
          language: jellyfinLanguage(mapping.languageHint),
          stream: uploadStream,
          contentLength,
          isForced: /(^|[.\-_\s])forced([.\-_\s]|$)/i.test(lowerName),
          isHearingImpaired: /(^|[.\-_\s])(sdh|hi)([.\-_\s]|$)/i.test(
            lowerName,
          ),
        });
      } finally {
        uploadStream.destroy();
      }
      deps.subtitleWorkspaces.markPlacementUploaded(
        deps.userId,
        workspaceId,
        planId,
        mapping.id,
      );
    }

    if (mapping.replacementSubtitleRef) {
      phase = "删除被替换的旧字幕";
      item = await deps.jellyfin.item(mapping.itemId);
      const replacement = resolveSubtitleReference(
        item,
        mapping.replacementSubtitleRef,
      );
      await deps.jellyfin.deleteSubtitle(mapping.itemId, replacement.index);
    }
    deps.subtitleWorkspaces.completePlacementMapping(
      deps.userId,
      workspaceId,
      planId,
      mapping.id,
    );
    return {
      mappingId: mapping.id,
      ok: true,
      uploaded: true,
      workspaceFileId: mapping.fileId,
      jellyfinItemId: mapping.itemId,
      jellyfinName: mapping.itemName,
      format: mapping.format,
      language: jellyfinLanguage(mapping.languageHint),
      removedLines: cleaning?.removed,
      cleaning: cleaning?.summary,
      replacementDeleted: Boolean(mapping.replacementSubtitleRef),
    };
  } catch (error) {
    const message = `${phase}失败：${errorDetails(error)}`;
    deps.subtitleWorkspaces.failPlacementMapping(
      deps.userId,
      workspaceId,
      planId,
      mapping.id,
      message,
    );
    return {
      mappingId: mapping.id,
      ok: false,
      uploaded: Boolean(mapping.uploadedAt),
      workspaceFileId: mapping.fileId,
      jellyfinItemId: mapping.itemId,
      error: message,
    };
  }
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = [error.message];
  let cause = error.cause;
  while (cause) {
    if (cause instanceof Error) {
      const code =
        "code" in cause && typeof cause.code === "string"
          ? `${cause.code}: `
          : "";
      details.push(`${code}${cause.message}`);
      cause = cause.cause;
    } else {
      details.push(String(cause));
      break;
    }
  }
  return details.join("；原因：");
}
