export interface SubtitleSearchResult {
  id: string;
  title: string;
  releaseName: string;
  subtitleType: string;
  languages: string[];
  format: string;
  isBilingual: boolean;
  fileSize: string;
  downloads: number;
  date: string;
  uploader: string;
  ratingUp?: number;
  ratingDown?: number;
  moviePageId?: string;
  commentCount?: number;
}

export interface SubtitleSearchResponse {
  source: "search" | "movie";
  moviePageId?: string;
  total: number;
  results: SubtitleSearchResult[];
}

export interface SubtitleComment {
  username: string;
  date: string;
  content: string;
  replies: SubtitleComment[];
}

export interface SubtitleDetail extends SubtitleSearchResult {
  formats: string[];
  rating: number;
  description: string;
  comments: SubtitleComment[];
}

export interface CaptchaChallenge {
  sessionId: string;
  svgContent: string;
  sid: string;
  cookies: string;
  downloadPageUrl: string;
}

export interface SubtitleDownload {
  data?: Buffer;
  filename?: string;
  captcha?: CaptchaChallenge;
}

export interface ExtractedSubtitle {
  filename: string;
  relativePath: string;
  format: string;
  sizeBytes: number;
  content?: string;
  data: Buffer;
}

export interface WorkspaceFile {
  id: string;
  archiveId: string;
  subtitleId: string;
  archiveName: string;
  filename: string;
  relativePath: string;
  format: string;
  sizeBytes: number;
  episodeHint?: number;
  languageHint: string;
  storageName: string;
}

export interface WorkspaceArchive {
  id: string;
  subtitleId: string;
  filename: string;
  fileIds: string[];
  createdAt: string;
}

export interface WorkspaceCaptcha {
  id: string;
  taskCode: string;
  subtitleId: string;
  challenge: CaptchaChallenge;
  expiresAt: string;
}

export interface WorkspacePlacementMapping {
  readonly id: string;
  readonly fileId: string;
  readonly fileName: string;
  readonly relativePath: string;
  readonly format: string;
  readonly languageHint: string;
  readonly episodeHint?: number;
  readonly fileDigest: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly itemType: "Movie" | "Episode";
  readonly itemSource: "local" | "openlist";
  readonly season?: number;
  readonly episode?: number;
  readonly replacementSubtitleRef?: string;
  readonly allowFileReuse: boolean;
  uploadedAt?: string;
  completedAt?: string;
  lastError?: string;
}

export interface WorkspacePlacementPlan {
  readonly id: string;
  readonly mappings: WorkspacePlacementMapping[];
  executing: boolean;
  readonly createdAt: string;
}

export interface SubtitleWorkspace {
  id: string;
  userId: string;
  archives: WorkspaceArchive[];
  captchas: WorkspaceCaptcha[];
  files: WorkspaceFile[];
  placementPlans: WorkspacePlacementPlan[];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
