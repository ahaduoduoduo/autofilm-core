import type { ConfigStore } from "../db/config-store.js";
import { jsonHeaders, requestJson, requestOk, withQuery } from "./http.js";

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  ProductionYear?: number;
  Path?: string;
  ProviderIds?: Record<string, string>;
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

  private headers(credential: string): Record<string, string> {
    return jsonHeaders("", credential ? { "x-emby-token": credential } : {});
  }

  private requireConfig() {
    const config = this.configs.service("jellyfin");
    if (!config) throw new Error("Jellyfin service is not configured");
    return config;
  }
}
