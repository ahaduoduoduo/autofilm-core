import type { ConfigStore } from "../db/config-store.js";
import { jsonHeaders, requestEnvelope } from "./http.js";

export interface OpenListTask {
  id: string;
  name: string;
  state: number;
  status: string;
  progress: number;
  total_bytes: number;
  error: string;
  start_time?: string;
  end_time?: string;
}

export interface OpenListAuthSession {
  session_id: string;
  state: string;
  expires_at: string;
  message?: string;
}

export class OpenListClient {
  constructor(private readonly configs: ConfigStore) {}

  async mkdir(path: string): Promise<void> {
    await this.post("/api/fs/mkdir", { path });
  }

  async startOfflineDownload(input: {
    path: string;
    url: string;
    tool?: string;
    deletePolicy?: string;
  }): Promise<OpenListTask[]> {
    const config = this.requireConfig();
    const data = await this.post<{ tasks: OpenListTask[] }>(
      "/api/fs/add_offline_download",
      {
        urls: [input.url],
        path: input.path,
        tool:
          input.tool ??
          String(config.options.offlineDownloadTool ?? "115 Cloud"),
        delete_policy: input.deletePolicy ?? "delete_on_upload_succeed",
      },
    );
    return data.tasks ?? [];
  }

  async listOfflineTasks(): Promise<OpenListTask[]> {
    const paths = [
      "/api/admin/task/offline_download/undone",
      "/api/admin/task/offline_download/done",
      "/api/admin/task/offline_download_transfer/undone",
      "/api/admin/task/offline_download_transfer/done",
    ];
    const groups = await Promise.all(
      paths.map((path) => this.get<OpenListTask[]>(path).catch(() => [])),
    );
    return groups.flat();
  }

  async scheduler(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>("/api/admin/autofilm/scheduler");
  }

  async startAuth(storageId: number): Promise<OpenListAuthSession> {
    return this.post<OpenListAuthSession>(
      "/api/admin/autofilm/auth-sessions",
      { storage_id: storageId },
    );
  }

  async authStatus(
    storageId: number,
    sessionId: string,
  ): Promise<OpenListAuthSession> {
    const config = this.requireConfig();
    const query = new URLSearchParams({
      storage_id: String(storageId),
      session_id: sessionId,
    });
    return requestEnvelope<OpenListAuthSession>(
      `${config.baseUrl}/api/admin/autofilm/auth-sessions/status?${query}`,
      { headers: jsonHeaders(config.credential) },
    );
  }

  async authQrCode(storageId: number, sessionId: string): Promise<Buffer> {
    const config = this.requireConfig();
    const query = new URLSearchParams({
      storage_id: String(storageId),
      session_id: sessionId,
    });
    const response = await fetch(
      `${config.baseUrl}/api/admin/autofilm/auth-sessions/qrcode.png?${query}`,
      {
        headers: jsonHeaders(config.credential),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`OpenList QR request returned HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async get<T>(path: string): Promise<T> {
    const config = this.requireConfig();
    return requestEnvelope<T>(`${config.baseUrl}${path}`, {
      headers: jsonHeaders(config.credential),
    });
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const config = this.requireConfig();
    return requestEnvelope<T>(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: jsonHeaders(config.credential),
      body: JSON.stringify(body),
    });
  }

  private requireConfig() {
    const config = this.configs.service("openlist");
    if (!config) throw new Error("OpenList service is not configured");
    return config;
  }
}
