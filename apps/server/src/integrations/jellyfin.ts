import type { ConfigStore } from "../db/config-store.js";
import { jsonHeaders, requestJson, requestOk, withQuery } from "./http.js";

export interface JellyfinItem {
  Id: string;
  Name: string;
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

export class JellyfinClient {
  constructor(private readonly configs: ConfigStore) {}

  async search(query: string): Promise<JellyfinItem[]> {
    const config = this.requireConfig();
    const url = withQuery(config.baseUrl, "/Items", {
      SearchTerm: query,
      Recursive: "true",
      IncludeItemTypes: "Movie,Series,Episode",
      Fields: "ProviderIds,ProductionYear,Path",
      Limit: "20",
    });
    const result = await requestJson<{ Items?: JellyfinItem[] }>(url, {
      headers: this.headers(config.credential),
    });
    return result.Items ?? [];
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
        Fields: "Path,ProviderIds,MediaSources,MediaStreams",
      }),
      { headers: this.headers(config.credential) },
    );
    const item = result.Items?.[0];
    if (!item) throw new Error("Jellyfin item was not found");
    return item;
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
    data: Buffer;
    isForced?: boolean;
    isHearingImpaired?: boolean;
  }): Promise<void> {
    const config = this.requireConfig();
    await requestOk(
      `${config.baseUrl}/Videos/${encodeURIComponent(input.itemId)}/Subtitles`,
      {
        method: "POST",
        headers: this.headers(config.credential),
        body: JSON.stringify({
          language: input.language,
          format: input.format.replace(/^\./, "").toLowerCase(),
          isForced: input.isForced ?? false,
          isHearingImpaired: input.isHearingImpaired ?? false,
          data: input.data.toString("base64"),
        }),
      },
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
