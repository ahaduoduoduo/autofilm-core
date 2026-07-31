import type { ConfigStore } from "../db/config-store.js";
import type { Readable } from "node:stream";
import { jsonHeaders, requestJson, requestOk, withQuery } from "./http.js";

export interface JellyfinItem {
  Id: string;
  Name: string;
  OriginalTitle?: string;
  Type: string;
  ProductionYear?: number;
  Path?: string;
  ProviderIds?: Record<string, string>;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  MediaSources?: Array<Record<string, unknown>>;
  MediaStreams?: Array<Record<string, unknown>>;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  SeriesName?: string;
  SeasonName?: string;
  SeriesId?: string;
  SeasonId?: string;
}

export interface JellyfinItemsPage {
  Items: JellyfinItem[];
  TotalRecordCount: number;
}

export interface JellyfinImageInfo {
  ImageType: string;
  ImageIndex?: number;
  ImageTag?: string;
  Path?: string;
  BlurHash?: string;
  Height?: number;
  Width?: number;
  Size?: number;
}

export interface JellyfinRemoteImage {
  ProviderName?: string;
  Url: string;
  ThumbnailUrl?: string;
  Height?: number;
  Width?: number;
  CommunityRating?: number;
  VoteCount?: number;
  Language?: string;
  Type?: string;
}

export interface JellyfinReplacementCandidate {
  path: string;
  name: string;
  container?: string;
  size: number;
  extraType?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  endingEpisodeNumber?: number;
}

export interface JellyfinReplacementFacts {
  path: string;
  size?: number;
  width?: number;
  height?: number;
  streams: Array<Record<string, unknown>>;
}

export interface JellyfinReplacementPreview {
  previewToken: string;
  current: JellyfinReplacementFacts;
  replacement: JellyfinReplacementFacts;
}

export class JellyfinClient {
  constructor(private readonly configs: ConfigStore) {}

  async search(query: string): Promise<JellyfinItem[]> {
    const config = this.requireConfig();
    const url = withQuery(config.baseUrl, "/Items", {
      SearchTerm: query,
      Recursive: "true",
      IncludeItemTypes: "Movie,Series,Episode,BoxSet",
      Fields: "ProviderIds,ProductionYear,Path,OriginalTitle",
      Limit: "20",
    });
    const result = await requestJson<{ Items?: JellyfinItem[] }>(url, {
      headers: this.headers(config.credential),
    });
    return result.Items ?? [];
  }

  async movies(startIndex = 0, limit = 200): Promise<JellyfinItemsPage> {
    const config = this.requireConfig();
    const result = await requestJson<{
      Items?: JellyfinItem[];
      TotalRecordCount?: number;
    }>(
      withQuery(config.baseUrl, "/Items", {
        Recursive: "true",
        IncludeItemTypes: "Movie",
        Fields:
          "Path,ProviderIds,ProductionYear,OriginalTitle,MediaSources,MediaStreams",
        EnableImages: "false",
        StartIndex: String(Math.max(0, startIndex)),
        Limit: String(Math.max(1, Math.min(limit, 500))),
        SortBy: "SortName",
        SortOrder: "Ascending",
      }),
      { headers: this.headers(config.credential) },
    );
    return {
      Items: result.Items ?? [],
      TotalRecordCount: result.TotalRecordCount ?? 0,
    };
  }

  async allMovies(): Promise<JellyfinItem[]> {
    const items: JellyfinItem[] = [];
    const pageSize = 200;
    let total = Number.POSITIVE_INFINITY;
    while (items.length < total) {
      const page = await this.movies(items.length, pageSize);
      total = page.TotalRecordCount;
      items.push(...page.Items);
      if (page.Items.length === 0) break;
    }
    return items;
  }

  async boxSetItems(
    boxSetId: string,
    startIndex = 0,
    limit = 200,
  ): Promise<JellyfinItemsPage> {
    const config = this.requireConfig();
    const result = await requestJson<{
      Items?: JellyfinItem[];
      TotalRecordCount?: number;
    }>(
      withQuery(config.baseUrl, "/Items", {
        ParentId: boxSetId,
        Recursive: "false",
        IncludeItemTypes: "Movie",
        CollapseBoxSetItems: "false",
        Fields:
          "Path,ProviderIds,ProductionYear,OriginalTitle,MediaSources,MediaStreams",
        EnableImages: "false",
        StartIndex: String(Math.max(0, startIndex)),
        Limit: String(Math.max(1, Math.min(limit, 500))),
        SortBy: "ProductionYear,SortName",
        SortOrder: "Ascending",
      }),
      { headers: this.headers(config.credential) },
    );
    return {
      Items: result.Items ?? [],
      TotalRecordCount: result.TotalRecordCount ?? 0,
    };
  }

  async allBoxSetItems(boxSetId: string): Promise<JellyfinItem[]> {
    const items: JellyfinItem[] = [];
    const pageSize = 200;
    let total = Number.POSITIVE_INFINITY;
    while (items.length < total) {
      const page = await this.boxSetItems(boxSetId, items.length, pageSize);
      total = page.TotalRecordCount;
      items.push(...page.Items);
      if (page.Items.length === 0) break;
    }
    return items;
  }

  async remoteRefresh(input: {
    path: string;
    recursive?: boolean;
    refresh?: boolean;
    forceProbe?: boolean;
    providerIds?: Record<string, string>;
    providerTarget?: "movie";
  }): Promise<void> {
    const config = this.requireConfig();
    await requestOk(
      `${config.baseUrl}/AutoFilm/RemoteRefresh`,
      {
        method: "POST",
        headers: this.headers(config.credential),
        body: JSON.stringify({
          path: input.path,
          recursive: input.recursive ?? true,
          refresh: input.refresh ?? false,
          force_probe: input.forceProbe ?? false,
          provider_ids: input.providerIds,
          provider_target: input.providerTarget,
        }),
      },
    );
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    const config = this.requireConfig();
    return requestJson<Record<string, unknown>>(
      `${config.baseUrl}/System/Info`,
      { headers: this.headers(config.credential) },
    );
  }

  async item(id: string): Promise<JellyfinItem> {
    const config = this.requireConfig();
    const result = await requestJson<{ Items?: JellyfinItem[] }>(
      withQuery(config.baseUrl, "/Items", {
        Ids: id,
        Recursive: "true",
        Fields:
          "Path,ProviderIds,ProductionYear,OriginalTitle,MediaSources,MediaStreams",
      }),
      { headers: this.headers(config.credential) },
    );
    const item = result.Items?.[0];
    if (!item) throw new Error("Jellyfin item was not found");
    return item;
  }

  async inspectReplacement(
    path: string,
  ): Promise<{
    requestedPath: string;
    candidates: JellyfinReplacementCandidate[];
  }> {
    const raw = await this.autoFilmPost<Record<string, unknown>>(
      "/AutoFilm/MediaReplacement/Inspect",
      {
        path,
        recursive: true,
      },
    );
    const candidates = arrayField(raw, "candidates", "Candidates").map(
      normalizeReplacementCandidate,
    );
    return {
      requestedPath:
        optionalStringField(raw, "requestedPath", "RequestedPath") ?? path,
      candidates,
    };
  }

  async previewReplacement(
    itemId: string,
    newPath: string,
    resolvedOriginalPath?: string,
  ): Promise<JellyfinReplacementPreview> {
    const raw = await this.autoFilmPost<Record<string, unknown>>(
      "/AutoFilm/MediaReplacement/Preview",
      {
        itemId,
        newPath,
        resolvedOriginalPath,
      },
    );
    return {
      previewToken: requiredStringField(
        raw,
        "previewToken",
        "PreviewToken",
      ),
      current: normalizeReplacementFacts(
        objectField(raw, "current", "Current"),
      ),
      replacement: normalizeReplacementFacts(
        objectField(raw, "replacement", "Replacement"),
      ),
    };
  }

  async applyReplacement(
    previewToken: string,
  ): Promise<Record<string, unknown>> {
    return this.autoFilmPost("/AutoFilm/MediaReplacement/Apply", {
      previewToken,
    });
  }

  async rollbackReplacement(
    rollbackToken: string,
  ): Promise<Record<string, unknown>> {
    return this.autoFilmPost("/AutoFilm/MediaReplacement/Rollback", {
      rollbackToken,
    });
  }

  async images(id: string): Promise<JellyfinImageInfo[]> {
    const config = this.requireConfig();
    return requestJson<JellyfinImageInfo[]>(
      `${config.baseUrl}/Items/${encodeURIComponent(id)}/Images`,
      { headers: this.headers(config.credential) },
    );
  }

  async image(
    id: string,
    type: string,
    index = 0,
    maxWidth = 1000,
  ): Promise<{ data: Buffer; contentType: string }> {
    const config = this.requireConfig();
    const url = withQuery(
      config.baseUrl,
      `/Items/${encodeURIComponent(id)}/Images/${encodeURIComponent(type)}/${index}`,
      { maxWidth: String(maxWidth), quality: "90" },
    );
    const response = await fetch(url, {
      headers: this.headers(config.credential),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Jellyfin image returned HTTP ${response.status}`);
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "image/jpeg",
    };
  }

  async remoteImages(input: {
    id: string;
    type: string;
    startIndex?: number;
    limit?: number;
    includeAllLanguages?: boolean;
  }): Promise<{ Images: JellyfinRemoteImage[]; TotalRecordCount: number }> {
    const config = this.requireConfig();
    return requestJson<{
      Images?: JellyfinRemoteImage[];
      TotalRecordCount?: number;
    }>(
      withQuery(
        config.baseUrl,
        `/Items/${encodeURIComponent(input.id)}/RemoteImages`,
        {
          Type: input.type,
          StartIndex: String(input.startIndex ?? 0),
          Limit: String(input.limit ?? 10),
          IncludeAllLanguages: String(input.includeAllLanguages ?? false),
        },
      ),
      { headers: this.headers(config.credential) },
    ).then((result) => ({
      Images: result.Images ?? [],
      TotalRecordCount: result.TotalRecordCount ?? 0,
    }));
  }

  async fetchRemoteImage(
    url: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Remote image URL must use HTTP or HTTPS");
    }
    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Remote image returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      throw new Error("Remote image response is not an image");
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType,
    };
  }

  async setRemoteImage(input: {
    id: string;
    type: string;
    imageUrl: string;
    providerName?: string;
  }): Promise<void> {
    const config = this.requireConfig();
    await requestOk(
      withQuery(
        config.baseUrl,
        `/Items/${encodeURIComponent(input.id)}/RemoteImages/Download`,
        {
          Type: input.type,
          ImageUrl: input.imageUrl,
          ProviderName: input.providerName ?? "",
        },
      ),
      {
        method: "POST",
        headers: this.headers(config.credential),
      },
    );
  }

  async deleteImage(id: string, type: string, index?: number): Promise<void> {
    const config = this.requireConfig();
    const suffix = index === undefined ? "" : `/${index}`;
    await requestOk(
      `${config.baseUrl}/Items/${encodeURIComponent(id)}/Images/${encodeURIComponent(type)}${suffix}`,
      {
        method: "DELETE",
        headers: this.headers(config.credential),
      },
    );
  }

  async refreshItem(
    id: string,
    mode: "default" | "full" = "default",
  ): Promise<void> {
    const config = this.requireConfig();
    const parameters =
      mode === "full"
        ? {
            MetadataRefreshMode: "FullRefresh",
            ImageRefreshMode: "FullRefresh",
            ReplaceAllMetadata: "true",
            ReplaceAllImages: "true",
          }
        : {
              MetadataRefreshMode: "Default",
              ImageRefreshMode: "Default",
              ReplaceAllMetadata: "false",
              ReplaceAllImages: "false",
            };
    await requestOk(
      withQuery(
        config.baseUrl,
        `/Items/${encodeURIComponent(id)}/Refresh`,
        parameters,
      ),
      { method: "POST", headers: this.headers(config.credential) },
    );
  }

  async episodes(seriesId: string): Promise<JellyfinItem[]> {
    const config = this.requireConfig();
    const result = await requestJson<{ Items?: JellyfinItem[] }>(
      withQuery(
        config.baseUrl,
        `/Shows/${encodeURIComponent(seriesId)}/Episodes`,
        {
          Fields:
            "Path,ProviderIds,MediaSources,MediaStreams",
          EnableImages: "false",
        },
      ),
      { headers: this.headers(config.credential) },
    );
    return result.Items ?? [];
  }

  async uploadSubtitle(input: {
    itemId: string;
    format: string;
    language: string;
    stream: Readable;
    contentLength: number;
    isForced?: boolean;
    isHearingImpaired?: boolean;
  }): Promise<void> {
    const config = this.requireConfig();
    const normalizedFormat = input.format.replace(/^\./, "").toLowerCase();
    await requestOk(
      withQuery(
        config.baseUrl,
        `/AutoFilm/Videos/${encodeURIComponent(input.itemId)}/Subtitles`,
        {
          format: normalizedFormat,
          language: input.language,
          isForced: String(input.isForced ?? false),
          isHearingImpaired: String(input.isHearingImpaired ?? false),
        },
      ),
      {
        method: "POST",
        headers: {
          ...this.headers(config.credential),
          "content-type": "application/octet-stream",
          "content-length": String(input.contentLength),
        },
        body: input.stream as unknown as BodyInit,
        // Node fetch requires half duplex when the request body is a stream.
        duplex: "half",
        signal: AbortSignal.timeout(10 * 60_000),
      } as RequestInit & { duplex: "half" },
    );
  }

  async deleteSubtitle(itemId: string, streamIndex: number): Promise<void> {
    const config = this.requireConfig();
    await requestOk(
      `${config.baseUrl}/Videos/${encodeURIComponent(itemId)}/Subtitles/${streamIndex}`,
      {
        method: "DELETE",
        headers: this.headers(config.credential),
      },
    );
  }

  async deleteItem(itemId: string): Promise<void> {
    const config = this.requireConfig();
    await requestOk(
      `${config.baseUrl}/Items/${encodeURIComponent(itemId)}`,
      {
        method: "DELETE",
        headers: this.headers(config.credential),
      },
    );
  }

  async subtitle(
    itemId: string,
    streamIndex: number,
    format: string,
  ): Promise<Buffer> {
    const config = this.requireConfig();
    const item = await this.item(itemId);
    const sourceId = String(item.MediaSources?.[0]?.Id ?? item.Id);
    const normalizedFormat = format.replace(/^\./, "").toLowerCase();
    const response = await fetch(
      `${config.baseUrl}/Videos/${encodeURIComponent(itemId)}/` +
        `${encodeURIComponent(sourceId)}/Subtitles/${streamIndex}/` +
        `Stream.${encodeURIComponent(normalizedFormat)}`,
      {
        headers: this.headers(config.credential),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Jellyfin subtitle returned HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async autoFilmPost<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const config = this.requireConfig();
    return requestJson<T>(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(config.credential),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  }

  private headers(credential: string): Record<string, string> {
    return jsonHeaders(
      "",
      credential
        ? {
            authorization:
              `MediaBrowser Client="AutoFilm", Device="Core", ` +
              `DeviceId="autofilm-core", Version="0.1.0", ` +
              `Token="${credential.replaceAll('"', "")}"`,
          }
        : {},
    );
  }

  private requireConfig() {
    const config = this.configs.service("jellyfin");
    if (!config) throw new Error("Jellyfin service is not configured");
    return config;
  }
}

function normalizeReplacementCandidate(
  value: unknown,
): JellyfinReplacementCandidate {
  const candidate = asRecord(value);
  return {
    path: requiredStringField(candidate, "path", "Path"),
    name: requiredStringField(candidate, "name", "Name"),
    container: optionalStringField(candidate, "container", "Container"),
    size: optionalNumberField(candidate, "size", "Size") ?? 0,
    extraType: optionalStringField(candidate, "extraType", "ExtraType"),
    seasonNumber: optionalNumberField(
      candidate,
      "seasonNumber",
      "SeasonNumber",
    ),
    episodeNumber: optionalNumberField(
      candidate,
      "episodeNumber",
      "EpisodeNumber",
    ),
    endingEpisodeNumber: optionalNumberField(
      candidate,
      "endingEpisodeNumber",
      "EndingEpisodeNumber",
    ),
  };
}

function normalizeReplacementFacts(value: Record<string, unknown>) {
  return {
    path: requiredStringField(value, "path", "Path"),
    size: optionalNumberField(value, "size", "Size"),
    width: optionalNumberField(value, "width", "Width"),
    height: optionalNumberField(value, "height", "Height"),
    streams: arrayField(value, "streams", "Streams").map(asRecord),
  };
}

function objectField(
  value: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> {
  for (const key of keys) {
    const result = value[key];
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
  }
  throw new Error(`Jellyfin response is missing ${keys[0]}`);
}

function arrayField(
  value: Record<string, unknown>,
  ...keys: string[]
): unknown[] {
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return [];
}

function requiredStringField(
  value: Record<string, unknown>,
  ...keys: string[]
): string {
  const result = optionalStringField(value, ...keys);
  if (!result) throw new Error(`Jellyfin response is missing ${keys[0]}`);
  return result;
}

function optionalStringField(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) {
      return value[key] as string;
    }
  }
  return undefined;
}

function optionalNumberField(
  value: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const result = value[key];
    if (typeof result === "number" && Number.isFinite(result)) return result;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Jellyfin response contains an invalid object");
  }
  return value as Record<string, unknown>;
}
