import type { SubtitleComment, SubtitleDetail, SubtitleWorkspace } from "../../subtitles/types.js";
import { analyzeAss, modifyAss } from "../../subtitles/ass-style.js";
import { extractSubtitles } from "../../subtitles/extract.js";
import { svgToPng } from "../../subtitles/captcha-recognizer.js";
import { resolveSubtitleReference } from "../../subtitles/references.js";
import type { AgentTool, ToolDependencies } from "../tool-types.js";
import { createSubtitlePlacementTools } from "./subtitle-placement.js";
import {
  objectSchema,
  requireArray,
  requireString,
  stringProperty,
} from "./schema.js";

export function createSubtitleTools(deps: ToolDependencies): AgentTool[] {
  return [
    {
      definition: {
        name: "search_subtitle",
        description:
          "在 SubHD 搜索字幕。系统会先识别关联影片页，再返回影片页中的完整字幕列表、下载量、评分和评论数量。",
        parameters: objectSchema(
          { keyword: stringProperty("搜索关键词，通常使用英文规范标题") },
          ["keyword"],
        ),
      },
      execute: async (args) => deps.subhd.search(requireString(args, "keyword")),
    },
    {
      definition: {
        name: "get_subtitle_detail",
        description:
          "按稳定 subtitle_id 获取 SubHD 字幕说明、版本、格式、评分、评论及评论回复。",
        parameters: objectSchema(
          { subtitle_id: stringProperty("search_subtitle 返回的稳定 ID") },
          ["subtitle_id"],
        ),
      },
      execute: async (args) =>
        detailForAgent(
          await deps.subhd.detail(requireString(args, "subtitle_id")),
        ),
    },
    {
      definition: {
        name: "create_subtitle_workspace",
        description:
          "为当前字幕任务创建一个临时工作区。一个工作区可累计下载、解压多个字幕包，任务结束或 24 小时后删除。",
        parameters: objectSchema({}),
      },
      execute: async () => workspaceView(deps.subtitleWorkspaces.create(deps.userId)),
    },
    {
      definition: {
        name: "get_subtitle_workspace",
        description:
          "读取字幕工作区的全部压缩包、解压目录结构、不可变文件 UUID、集号、语言和格式。",
        parameters: objectSchema(
          { workspace_id: stringProperty("临时字幕工作区 ID") },
          ["workspace_id"],
        ),
      },
      execute: async (args) =>
        workspaceView(
          deps.subtitleWorkspaces.require(
            deps.userId,
            requireString(args, "workspace_id"),
          ),
        ),
    },
    {
      definition: {
        name: "fetch_subtitle_archive",
        description:
          "把一个 SubHD 字幕包下载并解压到已有工作区。可对同一 workspace_id 并行调用多个字幕 ID；完成后用 get_subtitle_workspace 查看完整文件结构。",
        parameters: objectSchema(
          {
            workspace_id: stringProperty("create_subtitle_workspace 返回的 ID"),
            subtitle_id: stringProperty("SubHD 字幕 ID"),
          },
          ["workspace_id", "subtitle_id"],
        ),
      },
      execute: async (args) =>
        fetchArchive(
          deps,
          requireString(args, "workspace_id"),
          requireString(args, "subtitle_id"),
        ),
    },
    {
      definition: {
        name: "submit_captcha_answer",
        description:
          "使用用户回复的任务码，提交指定工作区中某个下载请求的人工验证码。不同成员和不同下载请求互不阻塞。",
        parameters: objectSchema(
          {
            workspace_id: stringProperty("字幕工作区 ID"),
            task_code: stringProperty("验证码图片和提示文本中的六位任务码"),
            captcha_text: stringProperty("用户输入的验证码字符"),
          },
          ["workspace_id", "task_code", "captcha_text"],
        ),
      },
      execute: async (args) =>
        submitCaptcha(
          deps,
          requireString(args, "workspace_id"),
          requireString(args, "task_code"),
          requireString(args, "captcha_text"),
        ),
    },
    ...createSubtitlePlacementTools(deps),
    {
      definition: {
        name: "analyze_subtitle_style",
        description:
          "通过 Jellyfin 读取一个外挂 ASS 字幕，分析分辨率、样式、使用量和对白示例。",
        parameters: objectSchema(
          {
            jellyfin_item_id: stringProperty("Movie 或 Episode 条目 ID"),
            subtitle_ref: stringProperty(
              "list_jellyfin_subtitle_targets 返回的不可变字幕引用",
            ),
          },
          ["jellyfin_item_id", "subtitle_ref"],
        ),
      },
      execute: async (args) => {
        const itemId = requireString(args, "jellyfin_item_id");
        const subtitleRef = requireString(args, "subtitle_ref");
        const item = await deps.jellyfin.item(itemId);
        const resolved = resolveSubtitleReference(item, subtitleRef);
        const data = await deps.jellyfin.subtitle(itemId, resolved.index, "ass");
        return { itemId, subtitleRef, ...analyzeAss(data.toString("utf8")) };
      },
    },
    {
      definition: {
        name: "adjust_subtitle_style",
        description:
          "通过 Jellyfin 读取 ASS、按旧版规则修改选定对白样式，再作为新的 chi ASS 字幕交给 Jellyfin 保存。",
        parameters: objectSchema(
          {
            jellyfin_item_id: stringProperty("Movie 或 Episode 条目 ID"),
            subtitle_ref: stringProperty(
              "list_jellyfin_subtitle_targets 返回的不可变字幕引用",
            ),
            style_names: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
            },
            font_size: { type: "number" },
            primary_color: { type: "string" },
            outline_color: { type: "string" },
            alignment: { type: "number" },
            margin_v: { type: "number" },
            move_to_bottom: { type: "boolean" },
            move_to_black_bar: { type: "boolean" },
            inline_mode: {
              type: "string",
              enum: ["keep", "scale", "remove"],
            },
          },
          ["jellyfin_item_id", "subtitle_ref", "style_names"],
        ),
      },
      execute: async (args) => adjustSubtitleStyle(deps, args),
    },
  ];
}

async function fetchArchive(
  deps: ToolDependencies,
  workspaceId: string,
  subtitleId: string,
): Promise<Record<string, unknown>> {
  deps.subtitleWorkspaces.require(deps.userId, workspaceId);
  const result = await deps.subtitleDownloads.download(subtitleId);
  if (result.data && result.filename) {
    return appendArchive(
      deps,
      workspaceId,
      subtitleId,
      result.data,
      result.filename,
    );
  }
  if (!result.captcha) throw new Error("SubHD 没有返回字幕文件或验证码");
  const captcha = deps.subtitleWorkspaces.addCaptcha({
    userId: deps.userId,
    workspaceId,
    subtitleId,
    challenge: result.captcha,
  });
  return publishCaptcha(
    deps,
    workspaceId,
    captcha.taskCode,
    result.captcha.svgContent,
    false,
    result.attempts,
  );
}

async function submitCaptcha(
  deps: ToolDependencies,
  workspaceId: string,
  taskCode: string,
  answer: string,
): Promise<Record<string, unknown>> {
  const captcha = deps.subtitleWorkspaces.captchaByTaskCode(
    deps.userId,
    workspaceId,
    taskCode,
  );
  const result = await deps.subtitleDownloads.submitCaptcha(
    captcha.challenge,
    answer,
  );
  if (result.captcha) {
    deps.subtitleWorkspaces.updateCaptcha(
      deps.userId,
      workspaceId,
      captcha.id,
      result.captcha,
    );
    return publishCaptcha(
      deps,
      workspaceId,
      captcha.taskCode,
      result.captcha.svgContent,
      true,
    );
  }
  if (!result.data || !result.filename) {
    throw new Error("SubHD 没有返回字幕文件");
  }
  deps.subtitleWorkspaces.removeCaptcha(deps.userId, workspaceId, captcha.id);
  return appendArchive(
    deps,
    workspaceId,
    captcha.subtitleId,
    result.data,
    result.filename,
  );
}

function appendArchive(
  deps: ToolDependencies,
  workspaceId: string,
  subtitleId: string,
  data: Buffer,
  filename: string,
): Record<string, unknown> {
  const files = extractSubtitles(data, filename);
  const result = deps.subtitleWorkspaces.appendArchive({
    userId: deps.userId,
    workspaceId,
    subtitleId,
    filename,
    files,
  });
  return {
    state: "ready",
    addedArchiveId: result.archive.id,
    addedFiles: result.archive.fileIds.length,
    workspace: workspaceView(result.workspace),
  };
}

async function publishCaptcha(
  deps: ToolDependencies,
  workspaceId: string,
  taskCode: string,
  svgContent: string,
  incorrect: boolean,
  automaticAttempts = 0,
): Promise<Record<string, unknown>> {
  const png = await svgToPng(svgContent);
  const fileName = `subhd-captcha-${taskCode}.png`;
  const token = deps.media.create({
    content: png,
    contentType: "image/png",
    fileName,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    reads: 10,
  });
  const mediaUrl = `${deps.mediaBaseUrl}/v1/media/${token}`;
  if (deps.notificationTarget) {
    deps.outbox.enqueueMessages({
      userId: deps.userId,
      ...deps.notificationTarget,
      messages: [
        {
          type: "text",
          text: incorrect
            ? `验证码任务 ${taskCode} 不正确，已生成新图片。请回复“${taskCode} 图片字符”。`
            : `验证码任务 ${taskCode} 自动识别失败。请回复“${taskCode} 图片字符”。`,
        },
        {
          type: "image",
          media_url: mediaUrl,
          file_name: fileName,
        },
      ],
    });
  }
  return {
    state: "captcha_required",
    workspaceId,
    taskCode,
    automaticAttempts,
    mediaUrl,
    instruction:
      `等待当前成员回复任务码 ${taskCode} 和图片字符；再使用对应 workspace_id 与 task_code 调用 submit_captcha_answer。`,
  };
}

async function adjustSubtitleStyle(
  deps: ToolDependencies,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const itemId = requireString(args, "jellyfin_item_id");
  const subtitleRef = requireString(args, "subtitle_ref");
  const item = await deps.jellyfin.item(itemId);
  const resolved = resolveSubtitleReference(item, subtitleRef);
  const styleNames = requireArray(args, "style_names").map((value) => {
    if (typeof value !== "string" || !value) {
      throw new Error("style_names 只能包含非空字符串");
    }
    return value;
  });
  const content = (
    await deps.jellyfin.subtitle(itemId, resolved.index, "ass")
  ).toString("utf8");
  const modified = modifyAss(content, {
    styleNames,
    changes: {
      fontSize:
        typeof args.font_size === "number" ? args.font_size : undefined,
      primaryColour:
        typeof args.primary_color === "string"
          ? args.primary_color
          : undefined,
      outlineColour:
        typeof args.outline_color === "string"
          ? args.outline_color
          : undefined,
      alignment:
        typeof args.alignment === "number" ? args.alignment : undefined,
      marginV: typeof args.margin_v === "number" ? args.margin_v : undefined,
    },
    moveToBottom: args.move_to_bottom === true,
    moveToBlackBar: args.move_to_black_bar === true,
    inlineMode:
      args.inline_mode === "scale" || args.inline_mode === "remove"
        ? args.inline_mode
        : "keep",
    blackBarMarginV: 30,
  });
  await deps.jellyfin.uploadSubtitle({
    itemId,
    format: "ass",
    language: "chi",
    data: Buffer.from(modified, "utf8"),
  });
  return {
    itemId,
    sourceSubtitleRef: subtitleRef,
    uploaded: true,
    language: "chi",
    styles: styleNames,
  };
}

function workspaceView(workspace: SubtitleWorkspace): Record<string, unknown> {
  return {
    id: workspace.id,
    expiresAt: workspace.expiresAt,
    archiveCount: workspace.archives.length,
    fileCount: workspace.files.length,
    pendingCaptchas: workspace.captchas.map((captcha) => ({
      taskCode: captcha.taskCode,
      subtitleId: captcha.subtitleId,
      expiresAt: captcha.expiresAt,
    })),
    archives: workspace.archives.map((archive) => ({
      archiveId: archive.id,
      subtitleId: archive.subtitleId,
      filename: archive.filename,
      files: archive.fileIds.map((fileId) => {
        const file = workspace.files.find((candidate) => candidate.id === fileId);
        if (!file) return { workspaceFileId: fileId, missing: true };
        return {
          workspaceFileId: file.id,
          relativePath: file.relativePath,
          filename: file.filename,
          format: file.format,
          sizeBytes: file.sizeBytes,
          episodeHint: file.episodeHint,
          languageHint: file.languageHint,
        };
      }),
    })),
  };
}

function detailForAgent(detail: SubtitleDetail): Record<string, unknown> {
  const aliases = new Map<string, string>();
  let sequence = 0;
  const alias = (username: string) => {
    if (username === detail.uploader) return "作者";
    const current = aliases.get(username);
    if (current) return current;
    sequence += 1;
    const value = `user-${sequence}`;
    aliases.set(username, value);
    return value;
  };
  const flattened: Array<Record<string, unknown>> = [];
  const seen = new Map<string, number>();
  const append = (comment: SubtitleComment, parent?: string) => {
    const content = comment.content.trim();
    const count = seen.get(content) ?? 0;
    seen.set(content, count + 1);
    if (count === 0 && flattened.length < 20) {
      flattened.push({
        user: alias(comment.username),
        parent,
        content,
        date: comment.date,
      });
    }
    for (const reply of comment.replies) {
      append(reply, alias(comment.username));
    }
  };
  for (const comment of detail.comments) append(comment);
  return {
    ...detail,
    comments: flattened.map((comment) => ({
      ...comment,
      duplicateCount: seen.get(String(comment.content)) ?? 1,
    })),
    totalTopLevelComments: detail.comments.length,
  };
}
