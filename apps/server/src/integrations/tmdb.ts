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
  episodes: Array<{
    id: number;
    name: string;
    episodeNumber: number;
    airDate: string;
    overview: string;
  }>;
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
      episodes?: Array<{
        id: number;
        name?: string;
        episode_number?: number;
        air_date?: string;
        overview?: string;
      }>;
    }>(url, { headers: { ...auth.headers, accept: "application/json" } });
    return {
      id: result.id,
      name: result.name ?? `Season ${seasonNumber}`,
      seasonNumber: result.season_number ?? seasonNumber,
      airDate: result.air_date ?? "",
      episodes: (result.episodes ?? []).map((episode) => ({
        id: episode.id,
        name: episode.name ?? "",
        episodeNumber: episode.episode_number ?? 0,
        airDate: episode.air_date ?? "",
        overview: episode.overview ?? "",
      })),
    };
  }
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
