import type { ConfigStore } from "../db/config-store.js";
import { requestJson, withQuery } from "./http.js";

export interface CatalogItem {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle: string;
  overview: string;
  releaseDate: string;
  posterPath: string;
}

export interface CatalogDetails extends CatalogItem {
  englishTitle: string;
}

export interface TmdbSeason {
  id: number;
  name: string;
  seasonNumber: number;
  airDate: string;
  overview: string;
  voteAverage: number | null;
  voteCount: number | null;
  episodes: Array<{
    id: number;
    name: string;
    episodeNumber: number;
    airDate: string;
    overview: string;
    voteAverage: number | null;
    voteCount: number | null;
  }>;
}

export interface TmdbMetadata {
  scope: "movie" | "tv" | "season" | "episode";
  mediaType: "movie" | "tv";
  tmdbId: number;
  id: number;
  title: string;
  originalTitle: string;
  seasonNumber?: number;
  episodeNumber?: number;
  airDate: string;
  overview: string;
  overviewLanguage: string | null;
  voteAverage: number | null;
  voteCount: number | null;
}

export interface TmdbImage {
  data: Buffer;
  contentType: string;
}

interface TmdbItem {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string;
  vote_average?: number;
  vote_count?: number;
}

export class TmdbClient {
  constructor(private readonly configs: ConfigStore) {}

  async search(query: string): Promise<CatalogItem[]> {
    const config = this.configs.service("tmdb");
    if (!config) throw new Error("TMDB service is not configured");
    const auth = tmdbAuth(config.credential);
    const url = withQuery(
      config.baseUrl || "https://api.themoviedb.org/3",
      "/search/multi",
      {
        query,
        language: String(config.options.language ?? "zh-CN"),
        ...auth.query,
      },
    );
    const data = await requestJson<{ results?: TmdbItem[] }>(url, {
      headers: {
        ...auth.headers,
        accept: "application/json",
      },
    });
    return (data.results ?? [])
      .filter((item) => item.media_type === "movie" || item.media_type === "tv")
      .slice(0, 12)
      .map(toCatalogItem);
  }

  async trending(): Promise<CatalogItem[]> {
    const config = this.configs.service("tmdb");
    if (!config) throw new Error("TMDB service is not configured");
    const auth = tmdbAuth(config.credential);
    const url = withQuery(
      config.baseUrl || "https://api.themoviedb.org/3",
      "/trending/all/week",
      {
        language: String(config.options.language ?? "zh-CN"),
        ...auth.query,
      },
    );
    const data = await requestJson<{ results?: TmdbItem[] }>(url, {
      headers: {
        ...auth.headers,
        accept: "application/json",
      },
    });
    return (data.results ?? [])
      .filter((item) => item.media_type === "movie" || item.media_type === "tv")
      .slice(0, 12)
      .map(toCatalogItem);
  }

  async details(
    tmdbId: number,
    mediaType: "movie" | "tv",
  ): Promise<CatalogDetails> {
    const config = this.configs.service("tmdb");
    if (!config) throw new Error("TMDB service is not configured");
    const auth = tmdbAuth(config.credential);
    const request = (language: string) =>
      requestJson<TmdbItem>(
        withQuery(
          config.baseUrl || "https://api.themoviedb.org/3",
          `/${mediaType}/${tmdbId}`,
          { language, ...auth.query },
        ),
        { headers: { ...auth.headers, accept: "application/json" } },
      );
    const configuredLanguage = String(config.options.language ?? "zh-CN");
    const localizedPromise = request(configuredLanguage);
    const [localized, english] =
      configuredLanguage === "en-US"
        ? await localizedPromise.then((result) => [result, result] as const)
        : await Promise.all([localizedPromise, request("en-US")]);
    return {
      ...toCatalogItem({ ...localized, id: tmdbId, media_type: mediaType }),
      englishTitle:
        english.title ??
        english.name ??
        localized.original_title ??
        localized.original_name ??
        "",
    };
  }

  async season(tmdbId: number, seasonNumber: number): Promise<TmdbSeason> {
    const config = this.configs.service("tmdb");
    if (!config) throw new Error("TMDB service is not configured");
    const auth = tmdbAuth(config.credential);
    const url = withQuery(
      config.baseUrl || "https://api.themoviedb.org/3",
      `/tv/${tmdbId}/season/${seasonNumber}`,
      {
        language: String(config.options.language ?? "zh-CN"),
        ...auth.query,
      },
    );
    const result = await requestJson<{
      id: number;
      name?: string;
      season_number?: number;
      air_date?: string;
      overview?: string;
      vote_average?: number;
      vote_count?: number;
      episodes?: Array<{
        id: number;
        name?: string;
        episode_number?: number;
        air_date?: string;
        overview?: string;
        vote_average?: number;
        vote_count?: number;
      }>;
    }>(url, { headers: { ...auth.headers, accept: "application/json" } });
    return {
      id: result.id,
      name: result.name ?? `Season ${seasonNumber}`,
      seasonNumber: result.season_number ?? seasonNumber,
      airDate: result.air_date ?? "",
      overview: result.overview ?? "",
      voteAverage: nullableNumber(result.vote_average),
      voteCount: nullableNumber(result.vote_count),
      episodes: (result.episodes ?? []).map((episode) => ({
        id: episode.id,
        name: episode.name ?? "",
        episodeNumber: episode.episode_number ?? 0,
        airDate: episode.air_date ?? "",
        overview: episode.overview ?? "",
        voteAverage: nullableNumber(episode.vote_average),
        voteCount: nullableNumber(episode.vote_count),
      })),
    };
  }

  async metadata(input: {
    mediaType: "movie" | "tv";
    tmdbId: number;
    seasonNumber?: number;
    episodeNumber?: number;
  }): Promise<TmdbMetadata> {
    if (input.mediaType === "movie" && input.seasonNumber !== undefined) {
      throw new Error("电影元数据不能指定季或集");
    }
    if (
      input.episodeNumber !== undefined &&
      input.seasonNumber === undefined
    ) {
      throw new Error("查询单集元数据时必须指定季号");
    }
    const config = this.configs.service("tmdb");
    if (!config) throw new Error("TMDB service is not configured");
    const auth = tmdbAuth(config.credential);
    const configuredLanguage = String(config.options.language ?? "zh-CN");
    const path =
      input.mediaType === "movie"
        ? `/movie/${input.tmdbId}`
        : input.episodeNumber !== undefined
          ? `/tv/${input.tmdbId}/season/${input.seasonNumber}/episode/${input.episodeNumber}`
          : input.seasonNumber !== undefined
            ? `/tv/${input.tmdbId}/season/${input.seasonNumber}`
            : `/tv/${input.tmdbId}`;
    const request = (language: string) =>
      requestJson<TmdbMetadataResponse>(
        withQuery(config.baseUrl || "https://api.themoviedb.org/3", path, {
          language,
          ...auth.query,
        }),
        { headers: { ...auth.headers, accept: "application/json" } },
      );
    const localizedPromise = request(configuredLanguage);
    const [localized, english] =
      configuredLanguage === "en-US"
        ? await localizedPromise.then((result) => [result, result] as const)
        : await Promise.all([localizedPromise, request("en-US")]);
    const localizedOverview = localized.overview?.trim() ?? "";
    const englishOverview = english.overview?.trim() ?? "";
    const scope =
      input.mediaType === "movie"
        ? "movie"
        : input.episodeNumber !== undefined
          ? "episode"
          : input.seasonNumber !== undefined
            ? "season"
            : "tv";
    return {
      scope,
      mediaType: input.mediaType,
      tmdbId: input.tmdbId,
      id: localized.id,
      title:
        localized.title ??
        localized.name ??
        english.title ??
        english.name ??
        "",
      originalTitle:
        localized.original_title ??
        localized.original_name ??
        english.original_title ??
        english.original_name ??
        "",
      seasonNumber:
        localized.season_number ?? input.seasonNumber,
      episodeNumber:
        localized.episode_number ?? input.episodeNumber,
      airDate:
        localized.release_date ??
        localized.first_air_date ??
        localized.air_date ??
        "",
      overview: localizedOverview || englishOverview,
      overviewLanguage: localizedOverview
        ? configuredLanguage
        : englishOverview
          ? "en-US"
          : null,
      voteAverage: nullableNumber(localized.vote_average),
      voteCount: nullableNumber(localized.vote_count),
    };
  }

  async poster(posterPath: string): Promise<TmdbImage> {
    if (!/^\/[A-Za-z0-9._-]+$/.test(posterPath)) {
      throw new Error("TMDB returned an invalid poster path");
    }
    const config = this.configs.service("tmdb");
    if (!config) throw new Error("TMDB service is not configured");
    const imageBaseUrl = String(
      config.options.imageBaseUrl ?? "https://image.tmdb.org/t/p/w500",
    ).replace(/\/+$/, "");
    const response = await fetch(`${imageBaseUrl}${posterPath}`, {
      headers: { accept: "image/*" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`TMDB poster returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error("TMDB poster response is not an image");
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 8 * 1024 * 1024) {
      throw new Error("TMDB poster exceeds the 8 MiB limit");
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > 8 * 1024 * 1024) {
      throw new Error("TMDB poster exceeds the 8 MiB limit");
    }
    return { data, contentType };
  }
}

interface TmdbMetadataResponse extends TmdbItem {
  season_number?: number;
  episode_number?: number;
  air_date?: string;
}

function tmdbAuth(credential: string): {
  headers: Record<string, string>;
  query: Record<string, string>;
} {
  const normalized = credential.trim();
  return /^[a-f0-9]{32}$/i.test(normalized)
    ? { headers: {}, query: { api_key: normalized } }
    : {
        headers: normalized ? { authorization: `Bearer ${normalized}` } : {},
        query: {},
      };
}

function toCatalogItem(item: TmdbItem): CatalogItem {
  return {
    id: item.id,
    mediaType: item.media_type as "movie" | "tv",
    title: item.title ?? item.name ?? "",
    originalTitle: item.original_title ?? item.original_name ?? "",
    overview: item.overview ?? "",
    releaseDate: item.release_date ?? item.first_air_date ?? "",
    posterPath: item.poster_path ?? "",
  };
}

function nullableNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
