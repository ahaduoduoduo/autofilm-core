import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db/database.js";
import type { UserStore } from "./db/user-store.js";
import type { ConfigStore } from "./db/config-store.js";
import type { ConversationStore } from "./db/conversation-store.js";
import type { TaskStore } from "./db/task-store.js";
import type { OutboxStore } from "./db/outbox-store.js";
import type { EphemeralMediaStore } from "./db/media-store.js";
import type { AgentService } from "./agent/service.js";
import type { JackettClient } from "./integrations/jackett.js";
import type { JellyfinClient } from "./integrations/jellyfin.js";
import type { OpenListClient } from "./integrations/openlist.js";
import type { TmdbClient } from "./integrations/tmdb.js";

export interface AppContext {
  config: AppConfig;
  db: AppDatabase;
  users: UserStore;
  configs: ConfigStore;
  conversations: ConversationStore;
  tasks: TaskStore;
  outbox: OutboxStore;
  media: EphemeralMediaStore;
  agent: AgentService;
  tmdb: TmdbClient;
  jackett: JackettClient;
  openList: OpenListClient;
  jellyfin: JellyfinClient;
}
