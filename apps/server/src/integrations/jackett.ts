import type { ConfigStore } from "../db/config-store.js";
import { requestJson, withQuery } from "./http.js";

export interface ReleaseResult {
  index: number;
  title: string;
  downloadUrl: string;
  size: number;
  seeders: number;
  peers: number;
  tracker: string;
  publishDate: string;
}

export interface ReleaseSearchPage {
  query: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  results: ReleaseResult[];
}

interface JackettResult {
  Title?: string;
  Link?: string;
  MagnetUri?: string;
  Guid?: string;
  Size?: number;
  Seeders?: number;
  Peers?: number;
  Tracker?: string;
  PublishDate?: string;
}

const PAGE_SIZE = 20;
const CACHE_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 32;

export class JackettClient {
  private readonly cache = new Map<
    string,
    { expiresAt: number; results: JackettResult[] }
  >();

  constructor(private readonly configs: ConfigStore) {}

  async search(query: string, page = 0): Promise<ReleaseSearchPage> {
    const config = this.configs.service("jackett");
    if (!config) throw new Error("Jackett service is not configured");
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error("Jackett query cannot be empty");
    if (!Number.isInteger(page) || page < 0) {
      throw new Error("Jackett page must be a non-negative integer");
    }
    const endpoint =
      String(config.options.path ?? "") ||
      "/api/v2.0/indexers/all/results";
    const cacheKey = `${config.baseUrl}\n${endpoint}\n${normalizedQuery}`;
    const results = await this.results(cacheKey, normalizedQuery, {
      baseUrl: config.baseUrl,
      endpoint,
      credential: config.credential,
    });
    const start = page * PAGE_SIZE;
    const pageResults = results.slice(start, start + PAGE_SIZE);
    return {
      query: normalizedQuery,
      page,
      pageSize: PAGE_SIZE,
      total: results.length,
      totalPages: Math.ceil(results.length / PAGE_SIZE),
      hasMore: start + pageResults.length < results.length,
      results: pageResults.map((item, offset) => ({
        index: start + offset,
        title: item.Title ?? "",
        downloadUrl: item.MagnetUri || item.Link || item.Guid || "",
        size: item.Size ?? 0,
        seeders: item.Seeders ?? 0,
        peers: item.Peers ?? 0,
        tracker: item.Tracker ?? "",
        publishDate: item.PublishDate ?? "",
      })),
    };
  }

  private async results(
    cacheKey: string,
    query: string,
    config: {
      baseUrl: string;
      endpoint: string;
      credential: string;
    },
  ): Promise<JackettResult[]> {
    this.deleteExpiredCacheEntries();
    const cached = this.cache.get(cacheKey);
    if (cached) return cached.results;

    const url = withQuery(config.baseUrl, config.endpoint, {
      apikey: config.credential,
      Query: query,
    });
    const data = await requestJson<{ Results?: JackettResult[] }>(url, {});
    const results = [...(data.Results ?? [])].sort(
      (left, right) =>
        (right.Size ?? 0) - (left.Size ?? 0) ||
        (left.Title ?? "").localeCompare(right.Title ?? ""),
    );
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      results,
    });
    return results;
  }

  private deleteExpiredCacheEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}
