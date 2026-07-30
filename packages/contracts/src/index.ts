export const AI_PROTOCOLS = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
  "gemini-generate-content",
] as const;

export type AiProtocol = (typeof AI_PROTOCOLS)[number];
export type UserRole = "owner" | "admin" | "member";
export type UserStatus = "active" | "disabled";
export type TaskState =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface AiProviderSummary {
  id: string;
  name: string;
  protocol: AiProtocol;
  baseUrl: string;
  enabled: boolean;
  hasApiKey: boolean;
  customHeaders: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProfile {
  id: string;
  providerId: string;
  name: string;
  model: string;
  isDefault: boolean;
  enabled: boolean;
  temperature: number | null;
  maxOutputTokens: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptConfigSummary {
  key: string;
  name: string;
  description: string;
  content: string;
  customized: boolean;
  defaultVersion: number;
  updatedAt: string;
}

export interface MemberSummary {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  identities: ExternalIdentity[];
  createdAt: string;
  updatedAt: string;
}

export interface ExternalIdentity {
  id: string;
  userId: string | null;
  channel: string;
  providerInstanceId: string;
  externalUserId: string;
  displayName: string;
  status: "pending" | "active" | "blocked";
  createdAt: string;
}

export interface ChannelConfigSummary {
  id: string;
  name: string;
  type: "native";
  providerInstanceId: string;
  baseUrl: string;
  enabled: boolean;
  hasInboundToken: boolean;
  hasOutboundToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ServiceType =
  | "openlist"
  | "jellyfin"
  | "jackett"
  | "tmdb"
  | "subhd";

export const DEFAULT_MEDIA_LIBRARY_ROOTS = {
  movie: "/115/nvideo/movie",
  tv: "/115/nvideo/tv",
} as const;

export interface WatchlistSummary {
  id: string;
  userId: string;
  tmdbId: number;
  title: string;
  originalTitle: string;
  season: number;
  totalEpisodes: number;
  conditions: string;
  destination: string;
  status: "active" | "completed" | "paused";
  nextCheckAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceConfigSummary {
  id: string;
  name: string;
  type: ServiceType;
  baseUrl: string;
  enabled: boolean;
  hasCredential: boolean;
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSummary {
  id: string;
  userId: string | null;
  type: string;
  title: string;
  state: TaskState;
  progress: number | null;
  statusText: string;
  externalId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface NativeAttachment {
  type: "image" | "video" | "audio" | "file";
  file_name?: string;
  content_type?: string;
  url?: string;
  data_base64?: string;
}

export interface NativeInboundEvent {
  version: "2026-07-01" | string;
  event_id: string;
  event_type: "message.created" | "conversation.reset";
  provider: string;
  provider_instance_id: string;
  conversation_id: string;
  sender_id: string;
  message_id: string;
  message_type: string;
  text?: string;
  attachments?: NativeAttachment[];
  timestamp: string;
  capabilities?: string[];
}

export interface NativeOutboundMessage {
  type: "text" | "image" | "video" | "audio" | "file";
  text?: string;
  media_url?: string;
  file_name?: string;
  reply_to_id?: string;
}

export interface NativeEventResponse {
  messages: NativeOutboundMessage[];
}
