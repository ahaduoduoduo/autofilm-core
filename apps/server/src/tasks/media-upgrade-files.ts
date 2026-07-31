import path from "node:path";
import type {
  OpenListClient,
  OpenListObject,
} from "../integrations/openlist.js";
import type { JellyfinItem } from "../integrations/jellyfin.js";

export function openListPathFromUri(value: unknown): string {
  const uri = String(value ?? "");
  if (!uri.startsWith("openlist:///")) {
    throw new Error("升级项缺少 OpenList 路径");
  }
  return `/${uri.slice("openlist:///".length)}`;
}

export function toOpenListUri(value: string): string {
  return `openlist:///${value.replace(/^\/+/, "")}`;
}

export function hasVideoStream(item: JellyfinItem): boolean {
  const streams =
    item.MediaStreams ??
    (item.MediaSources?.[0]?.MediaStreams as
      | Array<Record<string, unknown>>
      | undefined) ??
    [];
  return streams.some((stream) => stream.Type === "Video");
}

export async function moveOpenListObjectIdempotently(
  openList: OpenListClient,
  input: {
    sourcePath: string;
    destinationDirectory: string;
    destinationName?: string;
  },
): Promise<OpenListObject> {
  try {
    return await openList.moveObject(input);
  } catch (error) {
    const finalPath = path.posix.join(
      input.destinationDirectory,
      input.destinationName ?? path.posix.basename(input.sourcePath),
    );
    try {
      const existing = await openList.getObject(finalPath, true);
      if (!existing.is_dir) {
        try {
          await openList.getObject(input.sourcePath, true);
        } catch {
          return existing;
        }
      }
    } catch {
      // The destination does not prove that this exact move succeeded.
    }
    throw error;
  }
}
