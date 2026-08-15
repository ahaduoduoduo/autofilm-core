import type { ToolDefinition } from "../ai/types.js";
import type { TaskStore } from "../db/task-store.js";
import type { WatchlistStore } from "../db/watchlist-store.js";
import type { SubtitleWorkspaceStore } from "../subtitles/workspace-store.js";
import type { OutboxStore } from "../db/outbox-store.js";
import type { EphemeralMediaStore } from "../db/media-store.js";
import type { JackettClient } from "../integrations/jackett.js";
import type { JellyfinClient } from "../integrations/jellyfin.js";
import type { OpenListClient } from "../integrations/openlist.js";
import type { SubHDClient } from "../integrations/subhd.js";
import type { TmdbClient } from "../integrations/tmdb.js";
import type { SubtitleDownloadService } from "../subtitles/download-service.js";
import type { SubtitleProcessor } from "../subtitles/processor.js";
import type { MediaUpgradeStore } from "../db/media-upgrade-store.js";
import type { MediaUpgradeCheckStore } from "../db/media-upgrade-check-store.js";
import type { UserMemoryStore } from "../db/user-memory-store.js";

export interface AgentTool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface NotificationTarget {
  channel: string;
  providerInstanceId: string;
  targetId: string;
}

export interface ToolDependencies {
  userId: string;
  notificationTarget?: NotificationTarget;
  tasks: TaskStore;
  mediaUpgrades: MediaUpgradeStore;
  mediaUpgradeChecks: MediaUpgradeCheckStore;
  userMemories: UserMemoryStore;
  tmdb: TmdbClient;
  jackett: JackettClient;
  openList: OpenListClient;
  jellyfin: JellyfinClient;
  subhd: SubHDClient;
  subtitleDownloads: SubtitleDownloadService;
  subtitleProcessor: SubtitleProcessor;
  subtitleWorkspaces: SubtitleWorkspaceStore;
  watchlists: WatchlistStore;
  outbox: OutboxStore;
  media: EphemeralMediaStore;
  mediaBaseUrl: string;
  storageAuth?: {
    start(): Promise<unknown>;
  };
}
