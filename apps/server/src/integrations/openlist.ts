import type { ConfigStore } from "../db/config-store.js";
import { DEFAULT_MEDIA_LIBRARY_ROOTS } from "@autofilm/contracts";
import { jsonHeaders, requestEnvelope } from "./http.js";

export interface OpenListTask {
  id: string;
  name: string;
  state: number;
  status: string;
  progress: number;
  total_bytes: number;
  error: string;
  result_path?: string;
  start_time?: string;
  end_time?: string;
  provider_task_id?: string;
  provider_submitted_at?: string;
}

export const OPENLIST_TASK_STATE = {
  succeeded: 2,
  canceled: 4,
  failed: 7,
} as const;

export interface OpenListAuthSession {
  session_id: string;
  state: string;
  expires_at: string;
  message?: string;
}

export interface InstantOfflinePolicy {
  enabled: boolean;
  timeoutMs: number;
}

export interface MediaLibraryRoots {
  movie: string;
  tv: string;
}

export interface OpenListObject {
  path: string;
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  created: string;
  download_path?: string;
}

export class OpenListClient {
  constructor(private readonly configs: ConfigStore) {}

  async mkdir(path: string): Promise<void> {
    await this.post("/api/autofilm/directories", { path });
  }

  async startOfflineDownload(input: {
    path: string;
    url: string;
    tool?: string;
    deletePolicy?: string;
  }): Promise<OpenListTask[]> {
    const config = this.requireConfig();
    const data = await this.post<{ tasks: OpenListTask[] }>(
      "/api/autofilm/offline-downloads",
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
    const data = await this.get<{ tasks?: OpenListTask[] }>(
      "/api/autofilm/offline-tasks",
    );
    return data.tasks ?? [];
  }

  async deleteOfflineTask(taskId: string): Promise<void> {
    await this.post("/api/autofilm/offline-tasks/delete", {
      task_id: taskId,
    });
  }

  async getObject(path: string, refresh = false): Promise<OpenListObject> {
    return this.post("/api/autofilm/objects/get", {
      path: normalizePath(path),
      refresh,
    });
  }

  async listObjects(
    path: string,
    refresh = false,
  ): Promise<OpenListObject[]> {
    const result = await this.post<{ objects?: OpenListObject[] }>(
      "/api/autofilm/objects/list",
      { path: normalizePath(path), refresh },
    );
    return result.objects ?? [];
  }

  async moveObject(input: {
    sourcePath: string;
    destinationDirectory: string;
    destinationName?: string;
  }): Promise<OpenListObject> {
    return this.post("/api/autofilm/objects/move", {
      source_path: normalizePath(input.sourcePath),
      destination_directory: normalizePath(input.destinationDirectory),
      destination_name: input.destinationName,
    });
  }

  async deleteObject(path: string): Promise<void> {
    await this.post("/api/autofilm/objects/delete", {
      path: normalizePath(path),
    });
  }

  instantOfflinePolicy(): InstantOfflinePolicy {
    const config = this.requireConfig();
    const tool = String(config.options.offlineDownloadTool ?? "115 Cloud");
    const configured = Number(
      config.options.instantOfflineTimeoutSeconds ?? 40,
    );
    const timeoutSeconds = Number.isFinite(configured)
      ? Math.max(10, Math.min(120, configured))
      : 40;
    const timeoutEnabled =
      config.options.instantOfflineTimeoutEnabled ??
      config.options.instantOfflineRetryEnabled;
    return {
      enabled:
        timeoutEnabled !== false &&
        ["115 Cloud", "115 Open"].includes(tool),
      timeoutMs: timeoutSeconds * 1000,
    };
  }

  mediaLibraryRoots(): MediaLibraryRoots {
    const config = this.requireConfig();
    return {
      movie: normalizeRoot(
        String(
          config.options.movieLibraryRoot ??
            DEFAULT_MEDIA_LIBRARY_ROOTS.movie,
        ),
      ),
      tv: normalizeRoot(
        String(
          config.options.tvLibraryRoot ??
            DEFAULT_MEDIA_LIBRARY_ROOTS.tv,
        ),
      ),
    };
  }

  async scheduler(): Promise<Record<string, unknown>> {
    const config = this.requireConfig();
    const storageId = Number(config.options.authStorageId);
    if (!Number.isInteger(storageId) || storageId <= 0) {
      throw new Error("OpenList authStorageId is not configured");
    }
    const query = new URLSearchParams({ storage_id: String(storageId) });
    return this.get<Record<string, unknown>>(
      `/api/autofilm/scheduler?${query}`,
    );
  }

  async authState(): Promise<{
    authenticated: boolean;
    state: "authenticated" | "risk_controlled" | "error";
    requires_reauthentication: boolean;
    status_code?: number;
    detected_at?: string;
    message?: string;
  }> {
    const config = this.requireConfig();
    const storageId = this.authStorageId();
    const query = new URLSearchParams({ storage_id: String(storageId) });
    return this.get(`/api/autofilm/auth-state?${query}`);
  }

  authStorageId(): number {
    const storageId = Number(this.requireConfig().options.authStorageId);
    if (!Number.isInteger(storageId) || storageId <= 0) {
      throw new Error("OpenList authStorageId is not configured");
    }
    return storageId;
  }

  async startAuth(storageId: number): Promise<OpenListAuthSession> {
    return this.post<OpenListAuthSession>(
      "/api/autofilm/auth-sessions",
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
      `${config.baseUrl}/api/autofilm/auth-sessions/status?${query}`,
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
      `${config.baseUrl}/api/autofilm/auth-sessions/qrcode.png?${query}`,
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

function normalizePath(path: string): string {
  if (!path.startsWith("/") || path.includes("..")) {
    throw new Error("OpenList path must be a safe absolute path");
  }
  return path.replace(/\/+/g, "/");
}

function normalizeRoot(root: string): string {
  const normalized = normalizePath(root.trim());
  return normalized === "/" ? normalized : normalized.replace(/\/+$/g, "");
}
