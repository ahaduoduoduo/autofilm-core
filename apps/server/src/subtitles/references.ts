import { createHash } from "node:crypto";
import type { JellyfinItem } from "../integrations/jellyfin.js";

interface SubtitleReferencePayload {
  version: 1;
  itemId: string;
  digest: string;
}

export interface ResolvedSubtitleReference {
  index: number;
  stream: Record<string, unknown>;
}

export function createSubtitleReference(
  itemId: string,
  stream: Record<string, unknown>,
): string {
  const payload: SubtitleReferencePayload = {
    version: 1,
    itemId,
    digest: streamDigest(stream),
  };
  return `v1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export function resolveSubtitleReference(
  item: JellyfinItem,
  reference: string,
): ResolvedSubtitleReference {
  const payload = parseSubtitleReference(reference);
  if (payload.itemId !== item.Id) {
    throw new Error("字幕引用不属于当前 Jellyfin 条目");
  }
  const matches = (item.MediaStreams ?? []).filter(
    (stream) =>
      stream.Type === "Subtitle" &&
      stream.IsExternal === true &&
      streamDigest(stream) === payload.digest,
  );
  if (matches.length === 0) {
    throw new Error("Jellyfin 字幕流已经变化，原字幕引用已失效");
  }
  if (matches.length > 1) {
    throw new Error("Jellyfin 中存在多个相同字幕流，无法安全确定删除目标");
  }
  return {
    index: streamIndex(matches[0]!),
    stream: matches[0]!,
  };
}

function parseSubtitleReference(reference: string): SubtitleReferencePayload {
  if (!reference.startsWith("v1.")) throw new Error("字幕引用格式无效");
  try {
    const payload = JSON.parse(
      Buffer.from(reference.slice(3), "base64url").toString("utf8"),
    ) as Partial<SubtitleReferencePayload>;
    if (
      payload.version !== 1 ||
      typeof payload.itemId !== "string" ||
      typeof payload.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(payload.digest)
    ) {
      throw new Error("invalid payload");
    }
    return payload as SubtitleReferencePayload;
  } catch {
    throw new Error("字幕引用格式无效");
  }
}

function streamDigest(stream: Record<string, unknown>): string {
  const identity = {
    path: value(stream.Path),
    codec: value(stream.Codec),
    language: value(stream.Language),
    title: value(stream.Title),
    forced: stream.IsForced === true,
    hearingImpaired: stream.IsHearingImpaired === true,
  };
  return createHash("sha256")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex");
}

function streamIndex(stream: Record<string, unknown>): number {
  const index = Number(stream.Index);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("Jellyfin 字幕流缺少有效索引");
  }
  return index;
}

function value(input: unknown): string {
  return typeof input === "string" ? input : "";
}
