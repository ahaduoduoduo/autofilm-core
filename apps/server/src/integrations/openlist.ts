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

  instantOfflinePolicy(): InstantOfflinePolicy {
    const config = this.requireConfig();
    const tool = String(config.options.offlineDownloadTool ?? "115 Cloud");
    const configured = Number(
      config.options.instantOfflineTimeoutSeconds ?? 20,
    );
    const timeoutSeconds = Number.isFinite(configured)
      ? Math.max(10, Math.min(120, configured))
      : 20;
    return {
      enabled:
        config.options.instantOfflineRetryEnabled !== false &&
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
    const storageId = Number(config.options.authStorageId);
    if (!Number.isInteger(storageId) || storageId <= 0) {
      throw new Error("OpenList authStorageId is not configured");
    }
    const query = new URLSearchParams({ storage_id: String(storageId) });
    return this.get(`/api/autofilm/auth-state?${query}`);
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
