import { createHash } from "node:crypto";
import type { ConfigStore } from "../db/config-store.js";
import { requestJson, withQuery } from "./http.js";
import {
  normalizeMagnetUri,
  torrentToMagnet,
} from "./torrent-magnet.js";

export interface ReleaseResult {
  index: number;
  candidateId: string;
  title: string;
  size: number;
  seeders: number;
  peers: number;
  tracker: string;
  publishDate: string;
}

export interface JackettRelease extends Omit<ReleaseResult, "index"> {
  downloadUrl: string;
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
const MAX_CANDIDATE_ENTRIES = 1_024;
const MAX_TORRENT_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const RESOLUTION_CONCURRENCY = 6;

export class JackettClient {
  private readonly cache = new Map<
    string,
    { expiresAt: number; results: JackettResult[] }
  >();
  private readonly candidates = new Map<
    string,
    { expiresAt: number; release: JackettRelease }
  >();
  private readonly resolved = new Map<
    string,
    { expiresAt: number; magnetUri: string }
  >();
  private activeResolutions = 0;
  private readonly resolutionWaiters: Array<() => void> = [];

  constructor(private readonly configs: ConfigStore) {}

  async search(query: string, page = 0): Promise<ReleaseSearchPage> {
    const normalizedQuery = normalizeQuery(query);
    const results = await this.searchAll(normalizedQuery);
    if (!Number.isInteger(page) || page < 0) {
      throw new Error("Jackett page must be a non-negative integer");
    }
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
        candidateId: item.candidateId,
        title: item.title,
        size: item.size,
        seeders: item.seeders,
        peers: item.peers,
        tracker: item.tracker,
        publishDate: item.publishDate,
        index: start + offset,
      })),
    };
  }

  async searchAll(query: string): Promise<JackettRelease[]> {
    const config = this.configs.service("jackett");
    if (!config) throw new Error("Jackett service is not configured");
    const normalizedQuery = normalizeQuery(query);
    const endpoint =
      String(config.options.path ?? "") ||
      "/api/v2.0/indexers/all/results";
    const cacheKey = `${config.baseUrl}\n${endpoint}\n${normalizedQuery}`;
    const results = await this.results(cacheKey, normalizedQuery, {
      baseUrl: config.baseUrl,
      endpoint,
      credential: config.credential,
    });
    const releases = results.map((item) => {
      const downloadUrl = item.MagnetUri || item.Link || item.Guid || "";
      return {
        candidateId: candidateId(downloadUrl),
        title: item.Title ?? "",
        downloadUrl,
        size: item.Size ?? 0,
        seeders: item.Seeders ?? 0,
        peers: item.Peers ?? 0,
        tracker: item.Tracker ?? "",
        publishDate: item.PublishDate ?? "",
      };
    });
    for (const release of releases) this.rememberCandidate(release);
    return releases;
  }

  async resolveCandidate(candidate: string): Promise<{
    id: string;
    title: string;
    magnetUri: string;
  }> {
    this.deleteExpiredCandidateEntries();
    const entry = this.candidates.get(candidate);
    if (!entry) {
      throw new Error("Jackett 资源候选已过期，请重新搜索");
    }
    return {
      id: candidate,
      title: entry.release.title,
      magnetUri: await this.resolveDownloadUrl(
        entry.release.downloadUrl,
        entry.release.title,
      ),
    };
  }

  async resolveDownloadUrl(value: string, title: string): Promise<string> {
    const normalized = value.trim();
    if (normalized.startsWith("magnet:")) {
      return normalizeMagnetUri(normalized, title);
    }
    const cached = this.resolved.get(normalized);
    if (cached && cached.expiresAt > Date.now()) return cached.magnetUri;
    return this.withResolutionSlot(async () => {
      const secondCached = this.resolved.get(normalized);
      if (secondCached && secondCached.expiresAt > Date.now()) {
        return secondCached.magnetUri;
      }
      const magnetUri = await this.fetchTorrentMagnet(normalized, title);
      this.resolved.set(normalized, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        magnetUri,
      });
      return magnetUri;
    });
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

  private rememberCandidate(release: JackettRelease): void {
    this.deleteExpiredCandidateEntries();
    if (this.candidates.size >= MAX_CANDIDATE_ENTRIES) {
      const oldestKey = this.candidates.keys().next().value as
        | string
        | undefined;
      if (oldestKey) this.candidates.delete(oldestKey);
    }
    this.candidates.set(release.candidateId, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      release,
    });
  }

  private deleteExpiredCandidateEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.candidates) {
      if (entry.expiresAt <= now) this.candidates.delete(key);
    }
    for (const [key, entry] of this.resolved) {
      if (entry.expiresAt <= now) this.resolved.delete(key);
    }
  }

  private async fetchTorrentMagnet(value: string, title: string): Promise<string> {
    const config = this.configs.service("jackett");
    if (!config) throw new Error("Jackett service is not configured");
    let current = rewriteJackettDownloadUrl(value, config.baseUrl);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (current.startsWith("magnet:")) {
        return normalizeMagnetUri(current, title);
      }
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          headers: {
            accept: "application/x-bittorrent, text/plain;q=0.8, */*;q=0.1",
          },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new Error("无法从 Jackett 获取 torrent 文件");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Jackett torrent 重定向缺少地址");
        current = location.startsWith("magnet:")
          ? location
          : new URL(location, current).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`Jackett torrent 请求返回 HTTP ${response.status}`);
      }
      const content = await readLimitedBody(response, MAX_TORRENT_BYTES);
      const text = content.subarray(0, 1_024).toString("utf8").trim();
      if (text.startsWith("magnet:")) {
        return normalizeMagnetUri(text.split(/\s/)[0]!, title);
      }
      return torrentToMagnet(content, title);
    }
    throw new Error("Jackett torrent 重定向次数过多");
  }

  private async withResolutionSlot<T>(execute: () => Promise<T>): Promise<T> {
    if (this.activeResolutions >= RESOLUTION_CONCURRENCY) {
      await new Promise<void>((resolve) => this.resolutionWaiters.push(resolve));
    }
    this.activeResolutions += 1;
    try {
      return await execute();
    } finally {
      this.activeResolutions -= 1;
      this.resolutionWaiters.shift()?.();
    }
  }
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) throw new Error("Jackett query cannot be empty");
  return normalized;
}

function candidateId(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("base64url")
    .slice(0, 24);
}

function rewriteJackettDownloadUrl(value: string, baseUrl: string): string {
  let source: URL;
  try {
    source = new URL(value);
  } catch {
    throw new Error("Jackett 下载地址无效");
  }
  if (!["http:", "https:"].includes(source.protocol)) {
    throw new Error("Jackett 下载地址既不是 magnet 也不是 HTTP torrent");
  }
  if (source.pathname.startsWith("/dl/")) {
    const base = new URL(baseUrl);
    return new URL(`${source.pathname}${source.search}`, base).toString();
  }
  return source.toString();
}

async function readLimitedBody(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("torrent 文件超过 32 MiB 上限");
  }
  if (!response.body) throw new Error("Jackett torrent 响应为空");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("torrent 文件超过 32 MiB 上限");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
