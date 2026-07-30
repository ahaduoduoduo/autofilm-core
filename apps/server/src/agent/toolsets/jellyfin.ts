import type { AgentTool, ToolDependencies } from "../tool-types.js";
import { createSubtitleReference } from "../../subtitles/references.js";
import {
  objectSchema,
  requireString,
  stringProperty,
} from "./schema.js";

const IMAGE_TYPES = ["Primary", "Backdrop", "Logo", "Banner", "Thumb"];

export function createJellyfinTools(deps: ToolDependencies): AgentTool[] {
  return [
    {
      definition: {
        name: "view_jellyfin_images",
        description:
          "查看 Jellyfin 条目当前已经设置的图片，返回可在当前聊天打开的临时图片地址。",
        parameters: objectSchema(
          {
            jellyfin_item_id: stringProperty("Jellyfin 条目 ID"),
            image_type: {
              type: "string",
              enum: IMAGE_TYPES,
              description: "可选图片类型；不传则返回全部类型",
            },
          },
          ["jellyfin_item_id"],
        ),
      },
      execute: async (args) => {
        const itemId = requireString(args, "jellyfin_item_id");
        const requested =
          typeof args.image_type === "string" ? args.image_type : undefined;
        const images = (await deps.jellyfin.images(itemId)).filter(
          (image) => !requested || image.ImageType === requested,
        );
        const result = [];
        for (const image of images.slice(0, 20)) {
          const index = image.ImageIndex ?? 0;
          const content = await deps.jellyfin.image(
            itemId,
            image.ImageType,
            index,
          );
          result.push({
            ...image,
            mediaUrl: createMediaUrl(
              deps,
              content.data,
              content.contentType,
              `${itemId}-${image.ImageType}-${index}.jpg`,
            ),
          });
        }
        return { itemId, images: result };
      },
    },
    {
      definition: {
        name: "browse_remote_images",
        description:
          "浏览 Jellyfin 元数据供应方提供的替代图片；返回原始 image_url、供应方和临时预览地址。",
        parameters: objectSchema(
          {
            jellyfin_item_id: stringProperty("Jellyfin 条目 ID"),
            image_type: { type: "string", enum: IMAGE_TYPES },
            all_languages: { type: "boolean" },
            page: { type: "number", minimum: 0 },
          },
          ["jellyfin_item_id", "image_type"],
        ),
      },
      execute: async (args) => {
        const itemId = requireString(args, "jellyfin_item_id");
        const imageType = requireImageType(args);
        const page =
          typeof args.page === "number" && args.page >= 0
            ? Math.floor(args.page)
            : 0;
        const response = await deps.jellyfin.remoteImages({
          id: itemId,
          type: imageType,
          startIndex: page * 10,
          limit: 10,
          includeAllLanguages: args.all_languages === true,
        });
        const images = [];
        for (const [index, image] of response.Images.entries()) {
          const preview = await deps.jellyfin
            .fetchRemoteImage(image.ThumbnailUrl || image.Url)
            .catch(() => undefined);
          images.push({
            index: page * 10 + index,
            imageUrl: image.Url,
            providerName: image.ProviderName,
            language: image.Language,
            width: image.Width,
            height: image.Height,
            rating: image.CommunityRating,
            previewUrl: preview
              ? createMediaUrl(
                  deps,
                  preview.data,
                  preview.contentType,
                  `remote-${itemId}-${page * 10 + index}.jpg`,
                )
              : undefined,
          });
        }
        return {
          itemId,
          imageType,
          page,
          total: response.TotalRecordCount,
          images,
        };
      },
    },
    {
      definition: {
        name: "set_jellyfin_image",
        description:
          "把 browse_remote_images 返回的远程图片设置为 Jellyfin 条目图片。",
        parameters: objectSchema(
          {
            jellyfin_item_id: stringProperty("Jellyfin 条目 ID"),
            image_type: { type: "string", enum: IMAGE_TYPES },
            image_url: stringProperty("browse_remote_images 返回的 imageUrl"),
            provider_name: stringProperty("可选供应方名称"),
          },
          ["jellyfin_item_id", "image_type", "image_url"],
        ),
      },
      execute: async (args) => {
        const input = {
          id: requireString(args, "jellyfin_item_id"),
          type: requireImageType(args),
          imageUrl: requireString(args, "image_url"),
          providerName:
            typeof args.provider_name === "string"
              ? args.provider_name
              : undefined,
        };
        if (input.type === "Backdrop") {
          const backdrops = (await deps.jellyfin.images(input.id)).filter(
            (image) => image.ImageType === "Backdrop",
          );
          for (const image of backdrops.sort(
            (left, right) => (right.ImageIndex ?? 0) - (left.ImageIndex ?? 0),
          )) {
            await deps.jellyfin.deleteImage(
              input.id,
              "Backdrop",
              image.ImageIndex ?? 0,
            );
          }
        }
        await deps.jellyfin.setRemoteImage(input);
        return { updated: true, ...input };
      },
    },
    {
      definition: {
        name: "refresh_jellyfin_item",
        description:
          "刷新一个 Jellyfin 条目的元数据。default=常规，full=覆盖元数据和图片，missing=只查缺失内容。",
        parameters: objectSchema(
          {
            jellyfin_item_id: stringProperty("Jellyfin 条目 ID"),
            mode: {
              type: "string",
              enum: ["default", "full"],
            },
          },
          ["jellyfin_item_id"],
        ),
      },
      execute: async (args) => {
        const id = requireString(args, "jellyfin_item_id");
        const mode = args.mode === "full" ? args.mode : "default";
        await deps.jellyfin.refreshItem(id, mode);
        return { refreshed: true, id, mode };
      },
    },
    {
      definition: {
        name: "get_jellyfin_media_info",
        description:
          "读取电影或单集的容器、分辨率、HDR、视频编码、音轨和内封字幕流。",
        parameters: objectSchema(
          { jellyfin_item_id: stringProperty("Movie 或 Episode 条目 ID") },
          ["jellyfin_item_id"],
        ),
      },
      execute: async (args) => {
        const item = await deps.jellyfin.item(
          requireString(args, "jellyfin_item_id"),
        );
        return {
          id: item.Id,
          name: item.Name,
          type: item.Type,
          path: item.Path,
          mediaSources: item.MediaSources ?? [],
          mediaStreams: item.MediaStreams ?? [],
        };
      },
    },
    {
      definition: {
        name: "list_jellyfin_episodes",
        description:
          "列出 Jellyfin 剧集下的单集 ID、季集号、路径和媒体流；获取单集画质或字幕前使用。",
        parameters: objectSchema(
          { series_id: stringProperty("Jellyfin Series ID") },
          ["series_id"],
        ),
      },
      execute: async (args) => {
        const episodes = await deps.jellyfin.episodes(
          requireString(args, "series_id"),
        );
        return episodes.map((episode) => ({
          id: episode.Id,
          name: episode.Name,
          seriesName: episode.SeriesName,
          season: episode.ParentIndexNumber,
          episode: episode.IndexNumber,
          path: episode.Path,
          providerIds: episode.ProviderIds,
          mediaSources: episode.MediaSources,
          mediaStreams: episode.MediaStreams,
        }));
      },
    },
    {
      definition: {
        name: "list_jellyfin_subtitle_targets",
        description:
          "列出一个 Jellyfin 电影、单集或剧集中的字幕目标。电视剧返回各单集 ID；Agent 后续只使用这里的 Movie/Episode ID 配对字幕。",
        parameters: objectSchema(
          { jellyfin_item_id: stringProperty("Movie、Episode 或 Series ID") },
          ["jellyfin_item_id"],
        ),
      },
      execute: async (args) => {
        const id = requireString(args, "jellyfin_item_id");
        const root = await deps.jellyfin.item(id);
        const items =
          root.Type === "Series"
            ? await deps.jellyfin.episodes(id)
            : root.Type === "Movie" || root.Type === "Episode"
              ? [root]
              : [];
        if (items.length === 0) {
          throw new Error(
            `Jellyfin 条目 ${id} 是 ${root.Type}，不是电影、单集或剧集`,
          );
        }
        return {
          root: { id: root.Id, name: root.Name, type: root.Type },
          targets: items.map((item) => ({
            id: item.Id,
            name: item.Name,
            type: item.Type,
            seriesName: item.SeriesName,
            season: item.ParentIndexNumber,
            episode: item.IndexNumber,
            source: item.Path?.startsWith("openlist:///") ? "openlist" : "local",
            externalSubtitles: (item.MediaStreams ?? [])
              .filter(
                (stream) =>
                  stream.Type === "Subtitle" && stream.IsExternal === true,
              )
              .map((stream) => ({
                subtitleRef: createSubtitleReference(item.Id, stream),
                codec: stream.Codec,
                language: stream.Language,
                title: stream.Title,
                isForced: stream.IsForced,
                isHearingImpaired: stream.IsHearingImpaired,
              })),
          })),
        };
      },
    },
  ];
}

function requireImageType(args: Record<string, unknown>): string {
  const value = requireString(args, "image_type");
  if (!IMAGE_TYPES.includes(value)) throw new Error("不支持的 Jellyfin 图片类型");
  return value;
}

function createMediaUrl(
  deps: ToolDependencies,
  data: Buffer,
  contentType: string,
  fileName: string,
): string {
  const token = deps.media.create({
    content: data,
    contentType,
    fileName,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    reads: 10,
  });
  return `${deps.mediaBaseUrl}/v1/media/${token}`;
}
