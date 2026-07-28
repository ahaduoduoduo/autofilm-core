import type { ConfigStore } from "../db/config-store.js";
import { requestJson, withQuery } from "./http.js";

export interface ReleaseResult {
  title: string;
  link: string;
  magnetUri: string;
  size: number;
  seeders: number;
  peers: number;
  tracker: string;
  publishDate: string;
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

export class JackettClient {
  constructor(private readonly configs: ConfigStore) {}

  async search(query: string): Promise<ReleaseResult[]> {
    const config = this.configs.service("jackett");
    if (!config) throw new Error("Jackett service is not configured");
    const endpoint =
      String(config.options.path ?? "") ||
      "/api/v2.0/indexers/all/results";
    const url = withQuery(config.baseUrl, endpoint, {
      apikey: config.credential,
      Query: query,
    });
    const data = await requestJson<{ Results?: JackettResult[] }>(url, {});
    return (data.Results ?? []).slice(0, 40).map((item) => ({
      title: item.Title ?? "",
      link: item.Link ?? item.Guid ?? "",
      magnetUri: item.MagnetUri ?? "",
      size: item.Size ?? 0,
      seeders: item.Seeders ?? 0,
      peers: item.Peers ?? 0,
      tracker: item.Tracker ?? "",
      publishDate: item.PublishDate ?? "",
    }));
  }
}
