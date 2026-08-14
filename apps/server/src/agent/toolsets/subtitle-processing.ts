import path from "node:path";
import { Readable } from "node:stream";
import { openListPathFromUri } from "../../integrations/openlist-path.js";
import {
  createSubtitleReference,
  resolveSubtitleReference,
} from "../../subtitles/references.js";
import { decodeSubtitleText } from "../../subtitles/extract.js";
import type { WorkspaceProcessingEntry } from "../../subtitles/types.js";
import type { AgentTool, ToolDependencies } from "../tool-types.js";
import {
  objectSchema,
  requireArray,
  requireString,
  stringProperty,
} from "./schema.js";

const IMPORT_CONCURRENCY = 8;
const PROCESSING_CONCURRENCY = 4;
const TEXT_FORMATS = new Set(["ass", "ssa", "srt", "vtt"]);

export function createSubtitleProcessingTools(
  deps: ToolDependencies,
): AgentTool[] {
  return [
    {
      definition: {
        name: "import_openlist_subtitles",
        description:
          "把用户观看后明确选中的一条或多条现有 OpenList 外挂字幕导入同一个字幕工作区。只接受 Jellyfin Movie/Episode ID 和不可变字幕引用，不修改源字幕。",
        parameters: objectSchema(
          {
            workspace_id: stringProperty("create_subtitle_workspace 返回的工作区 ID"),
            targets: targetArraySchema(),
          },
          ["workspace_id", "targets"],
        ),
      },
      execute: async (args) =>
        importOpenListSubtitles(
          deps,
          requireString(args, "workspace_id"),
          requireArray(args, "targets"),
        ),
    },
    {
      definition: {
        name: "process_subtitle_workspace",
        description:
          "批量处理工作区中从 OpenList 导入的已有字幕。当前操作 mainland_wording 会让独立 AI 按文件读取完整双语字幕，只修改明显不符合中国大陆语言习惯的中文片段，并分别新增 chs 字幕；原字幕始终保留。",
        parameters: objectSchema(
          {
            workspace_id: stringProperty("字幕工作区 ID"),
            workspace_file_ids: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { type: "string" },
            },
            operations: {
              type: "array",
              minItems: 1,
              maxItems: 1,
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["mainland_wording"] },
                },
                required: ["type"],
                additionalProperties: false,
              },
            },
          },
          ["workspace_id", "workspace_file_ids", "operations"],
        ),
      },
      execute: async (args) =>
        processWorkspace(
          deps,
          requireString(args, "workspace_id"),
          requireArray(args, "workspace_file_ids"),
          requireArray(args, "operations"),
        ),
    },
  ];
}

async function importOpenListSubtitles(
  deps: ToolDependencies,
  workspaceId: string,
  values: unknown[],
): Promise<Record<string, unknown>> {
  if (values.length > 50) throw new Error("单次最多导入 50 个已有字幕");
  deps.subtitleWorkspaces.require(deps.userId, workspaceId);
  const targets = values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`第 ${index + 1} 个字幕目标格式无效`);
    }
    const target = value as Record<string, unknown>;
    return {
      itemId: requireString(target, "jellyfin_item_id"),
      subtitleRef: requireString(target, "subtitle_ref"),
    };
  });
  const keys = targets.map((target) => `${target.itemId}\u0000${target.subtitleRef}`);
  if (new Set(keys).size !== keys.length) throw new Error("字幕导入目标包含重复项");

  const results = await mapConcurrent(
    targets,
    IMPORT_CONCURRENCY,
    async (target) => importOne(deps, workspaceId, target),
  );
  const succeeded = results.filter((result) => result.ok).length;
  return {
    workspaceId,
    status:
      succeeded === results.length ? "success" : succeeded === 0 ? "failed" : "partial",
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

async function importOne(
  deps: ToolDependencies,
  workspaceId: string,
  target: { itemId: string; subtitleRef: string },
): Promise<Record<string, unknown>> {
  let phase = "读取 Jellyfin 字幕目标";
  try {
    const item = await deps.jellyfin.item(target.itemId);
    if (item.Type !== "Movie" && item.Type !== "Episode") {
      throw new Error(`Jellyfin 条目是 ${item.Type}，不是 Movie 或 Episode`);
    }
    if (!item.Path?.startsWith("openlist:///")) {
      throw new Error("字幕处理工作区只导入 OpenList 媒体的外挂字幕");
    }
    const resolved = resolveSubtitleReference(item, target.subtitleRef);
    const remotePath = openListPathFromUri(resolved.stream.Path);
    const format = subtitleFormat(remotePath, resolved.stream.Codec);
    phase = "从 OpenList 读取源字幕";
    const downloaded = await deps.openList.downloadObject(remotePath);
    const added = deps.subtitleWorkspaces.appendOpenListSubtitle({
      userId: deps.userId,
      workspaceId,
      jellyfinItemId: item.Id,
      jellyfinItemName: item.Name,
      subtitleRef: target.subtitleRef,
      openListPath: downloaded.object.path,
      format,
      language: stringValue(resolved.stream.Language),
      isForced: resolved.stream.IsForced === true,
      isHearingImpaired: resolved.stream.IsHearingImpaired === true,
      season: item.ParentIndexNumber,
      episode: item.IndexNumber,
      data: Buffer.from(decodeSubtitleText(downloaded.data), "utf8"),
    });
    return {
      ok: true,
      alreadyImported: added.existed,
      workspaceFileId: added.file.id,
      jellyfinItemId: item.Id,
      jellyfinName: item.Name,
      seriesName: item.SeriesName,
      season: item.ParentIndexNumber,
      episode: item.IndexNumber,
      format: added.file.format,
      language: added.file.languageHint,
      sizeBytes: added.file.sizeBytes,
    };
  } catch (error) {
    return {
      ok: false,
      jellyfinItemId: target.itemId,
      error: `${phase}失败：${errorMessage(error)}`,
    };
  }
}

async function processWorkspace(
  deps: ToolDependencies,
  workspaceId: string,
  fileValues: unknown[],
  operations: unknown[],
): Promise<Record<string, unknown>> {
  deps.subtitleWorkspaces.require(deps.userId, workspaceId);
  if (
    operations.length !== 1 ||
    !operations[0] ||
    typeof operations[0] !== "object" ||
    Array.isArray(operations[0]) ||
    (operations[0] as Record<string, unknown>).type !== "mainland_wording"
  ) {
    throw new Error("当前只支持 mainland_wording 字幕处理操作");
  }
  const fileIds = fileValues.map((value, index) => {
    if (typeof value !== "string" || !value) {
      throw new Error(`第 ${index + 1} 个 workspace_file_id 无效`);
    }
    return value;
  });
  if (fileIds.length > 50) throw new Error("单次最多处理 50 个字幕文件");
  if (new Set(fileIds).size !== fileIds.length) {
    throw new Error("字幕处理目标包含重复的工作区文件 ID");
  }
  const files = fileIds.map((fileId) =>
    deps.subtitleWorkspaces.fileById(deps.userId, workspaceId, fileId),
  );
  const itemIds = files.map((file) =>
    file.source.type === "jellyfin_openlist"
      ? file.source.jellyfinItemId
      : `invalid:${file.id}`,
  );
  if (new Set(itemIds).size !== itemIds.length) {
    throw new Error("同一个 Jellyfin 条目一次只能转换一条外挂字幕");
  }
  for (const file of files) {
    deps.subtitleWorkspaces.processingEntry(deps.userId, workspaceId, file.id);
  }

  const results = await mapConcurrent(
    fileIds,
    PROCESSING_CONCURRENCY,
    async (fileId) => processOne(deps, workspaceId, fileId),
  );
  const succeeded = results.filter((result) => result.ok).length;
  return {
    workspaceId,
    operation: "mainland_wording",
    outputLanguage: "chs",
    status:
      succeeded === results.length ? "success" : succeeded === 0 ? "failed" : "partial",
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

async function processOne(
  deps: ToolDependencies,
  workspaceId: string,
  fileId: string,
): Promise<Record<string, unknown>> {
  const file = deps.subtitleWorkspaces.fileById(deps.userId, workspaceId, fileId);
  if (file.source.type !== "jellyfin_openlist") {
    return {
      ok: false,
      workspaceFileId: fileId,
      error: "大陆用词转换只处理从 OpenList 导入的已有字幕",
    };
  }
  const existing = deps.subtitleWorkspaces.processingEntry(
    deps.userId,
    workspaceId,
    fileId,
  );
  if (existing.state === "completed") return completedView(file, existing, true);

  let phase = "读取字幕工作区文件";
  let processingBegan = false;
  try {
    const entry = deps.subtitleWorkspaces.beginProcessing(
      deps.userId,
      workspaceId,
      fileId,
    );
    processingBegan = true;
    if (entry.uploadedAt) {
      phase = "确认已经上传的新字幕";
      const outputRef = await findOutputSubtitleRef(deps, file, entry);
      const completed = deps.subtitleWorkspaces.completeProcessing(
        deps.userId,
        workspaceId,
        fileId,
        outputRef,
      );
      return completedView(file, completed, true);
    }

    const buffered = deps.subtitleWorkspaces.readFileById(
      deps.userId,
      workspaceId,
      fileId,
    );
    phase = "重新核对 Jellyfin 源字幕";
    const item = await deps.jellyfin.item(file.source.jellyfinItemId);
    resolveSubtitleReference(item, file.source.subtitleRef);
    const beforeSubtitleRefs = externalSubtitleRefs(item);

    phase = "使用独立 AI 转换大陆用词";
    const processed = await deps.subtitleProcessor.process(
      buffered.metadata.filename,
      buffered.data,
      [{ type: "mainland_wording" }],
    );
    const operation = processed.operations[0]!;
    if ((operation.rewrittenSegments ?? 0) === 0) {
      const completed = deps.subtitleWorkspaces.completeProcessing(
        deps.userId,
        workspaceId,
        fileId,
      );
      completed.eligibleEvents = operation.eligibleEvents;
      completed.rewrittenEvents = 0;
      completed.rewrittenSegments = 0;
      return completedView(file, completed, false);
    }

    phase = "把新 chs 字幕上传到 Jellyfin 和 OpenList";
    const stream = Readable.from([processed.data]);
    try {
      await deps.jellyfin.uploadSubtitle({
        itemId: file.source.jellyfinItemId,
        format: file.format,
        language: "chs",
        stream,
        contentLength: processed.data.byteLength,
        isForced: file.source.isForced,
        isHearingImpaired: file.source.isHearingImpaired,
      });
    } finally {
      stream.destroy();
    }
    const uploaded = deps.subtitleWorkspaces.markProcessingUploaded(
      deps.userId,
      workspaceId,
      fileId,
      {
        beforeSubtitleRefs,
        eligibleEvents: operation.eligibleEvents ?? 0,
        rewrittenEvents: operation.rewrittenEvents ?? 0,
        rewrittenSegments: operation.rewrittenSegments ?? 0,
      },
    );
    phase = "确认新 chs 字幕已经注册";
    const outputRef = await findOutputSubtitleRef(deps, file, uploaded);
    const completed = deps.subtitleWorkspaces.completeProcessing(
      deps.userId,
      workspaceId,
      fileId,
      outputRef,
    );
    return completedView(file, completed, false);
  } catch (error) {
    const message = `${phase}失败：${errorMessage(error)}`;
    const failed = processingBegan
      ? deps.subtitleWorkspaces.failProcessing(
          deps.userId,
          workspaceId,
          fileId,
          message,
        )
      : existing;
    return {
      ok: false,
      workspaceFileId: fileId,
      jellyfinItemId: file.source.jellyfinItemId,
      jellyfinName: file.source.jellyfinItemName,
      uploaded: Boolean(failed.uploadedAt),
      sourcePreserved: true,
      error: processingBegan ? failed.lastError : message,
    };
  }
}

async function findOutputSubtitleRef(
  deps: ToolDependencies,
  file: ReturnType<ToolDependencies["subtitleWorkspaces"]["fileById"]>,
  entry: WorkspaceProcessingEntry,
): Promise<string> {
  const source = file.source;
  if (source.type !== "jellyfin_openlist") {
    throw new Error("工作区文件不是 OpenList 字幕");
  }
  const item = await deps.jellyfin.item(source.jellyfinItemId);
  const previous = new Set(entry.beforeSubtitleRefs);
  const candidates = (item.MediaStreams ?? [])
    .filter(
      (stream) =>
        stream.Type === "Subtitle" &&
        stream.IsExternal === true &&
        stringValue(stream.Language).toLowerCase() === "chs" &&
        normalizedCodec(stream.Codec) === normalizedCodec(file.format) &&
        (stream.IsForced === true) === source.isForced &&
        (stream.IsHearingImpaired === true) === source.isHearingImpaired,
    )
    .map((stream) => createSubtitleReference(item.Id, stream))
    .filter((reference) => !previous.has(reference));
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? "Jellyfin 没有返回新上传的 chs 字幕流"
        : "Jellyfin 同时出现多个新 chs 字幕流，无法确定本次输出",
    );
  }
  return candidates[0]!;
}

function completedView(
  file: ReturnType<ToolDependencies["subtitleWorkspaces"]["fileById"]>,
  entry: WorkspaceProcessingEntry,
  alreadyCompleted: boolean,
): Record<string, unknown> {
  if (file.source.type !== "jellyfin_openlist") {
    throw new Error("工作区文件不是 OpenList 字幕");
  }
  return {
    ok: true,
    alreadyCompleted,
    workspaceFileId: file.id,
    jellyfinItemId: file.source.jellyfinItemId,
    jellyfinName: file.source.jellyfinItemName,
    format: file.format,
    language: "chs",
    eligibleEvents: entry.eligibleEvents ?? 0,
    rewrittenEvents: entry.rewrittenEvents ?? 0,
    rewrittenSegments: entry.rewrittenSegments ?? 0,
    uploaded: Boolean(entry.uploadedAt),
    sourcePreserved: true,
    newSubtitleRef: entry.outputSubtitleRef,
  };
}

function targetArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: 50,
    items: {
      type: "object",
      properties: {
        jellyfin_item_id: stringProperty("Jellyfin Movie 或 Episode ID"),
        subtitle_ref: stringProperty(
          "list_jellyfin_subtitle_targets 返回的不可变字幕引用",
        ),
      },
      required: ["jellyfin_item_id", "subtitle_ref"],
      additionalProperties: false,
    },
  };
}

function subtitleFormat(remotePath: string, codec: unknown): string {
  const extension = path.posix.extname(remotePath).slice(1).toLowerCase();
  const normalized = normalizedCodec(codec);
  const format = TEXT_FORMATS.has(extension) ? extension : normalized;
  if (!TEXT_FORMATS.has(format)) {
    throw new Error("大陆用词转换只支持 ASS、SSA、SRT 和 VTT 字幕");
  }
  return format;
}

function normalizedCodec(value: unknown): string {
  const normalized = stringValue(value).replace(/^\./, "").toLowerCase();
  if (normalized === "subrip") return "srt";
  if (normalized === "webvtt") return "vtt";
  return normalized;
}

function externalSubtitleRefs(item: {
  Id: string;
  MediaStreams?: Array<Record<string, unknown>>;
}): string[] {
  return (item.MediaStreams ?? [])
    .filter(
      (stream) => stream.Type === "Subtitle" && stream.IsExternal === true,
    )
    .map((stream) => createSubtitleReference(item.Id, stream));
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
