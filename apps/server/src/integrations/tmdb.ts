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
    const url = withQuery(
      config.baseUrl || "https://api.themoviedb.org/3",
      "/search/multi",
      { query, language: String(config.options.language ?? "zh-CN") },
    );
    const data = await requestJson<{ results?: TmdbItem[] }>(url, {
      headers: {
        authorization: `Bearer ${config.credential}`,
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
    const url = withQuery(
      config.baseUrl || "https://api.themoviedb.org/3",
      "/trending/all/week",
      { language: String(config.options.language ?? "zh-CN") },
    );
    const data = await requestJson<{ results?: TmdbItem[] }>(url, {
      headers: {
        authorization: `Bearer ${config.credential}`,
        accept: "application/json",
      },
    });
    return (data.results ?? [])
      .filter((item) => item.media_type === "movie" || item.media_type === "tv")
      .slice(0, 12)
      .map(toCatalogItem);
  }
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
