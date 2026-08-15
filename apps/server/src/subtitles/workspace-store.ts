import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { ReadStream } from "node:fs";
import path from "node:path";
import { episodeHint, languageHint } from "./hints.js";
import type {
  CaptchaChallenge,
  ExtractedSubtitle,
  SubtitleWorkspace,
  WorkspaceArchive,
  WorkspaceCaptcha,
  WorkspaceFile,
  WorkspacePlacementMapping,
  WorkspacePlacementPlan,
  WorkspaceProcessingEntry,
} from "./types.js";

const WORKSPACE_LIFETIME_MS = 24 * 60 * 60_000;
const CAPTCHA_LIFETIME_MS = 30 * 60_000;

export class SubtitleWorkspaceStore {
  private readonly root: string;
  private readonly workspaces = new Map<string, SubtitleWorkspace>();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "tmp", "subtitles");
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  create(userId: string): SubtitleWorkspace {
    const now = new Date().toISOString();
    const workspace: SubtitleWorkspace = {
      id: randomUUID(),
      userId,
      archives: [],
      captchas: [],
      files: [],
      placementPlans: [],
      processingEntries: [],
      expiresAt: expiresAt(WORKSPACE_LIFETIME_MS),
      createdAt: now,
      updatedAt: now,
    };
    mkdirSync(this.directory(workspace.id), { recursive: true, mode: 0o700 });
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  appendArchive(input: {
    userId: string;
    workspaceId: string;
    subtitleId: string;
    filename: string;
    files: ExtractedSubtitle[];
  }): { workspace: SubtitleWorkspace; archive: WorkspaceArchive } {
    const workspace = this.require(input.userId, input.workspaceId);
    const archiveId = randomUUID();
    const archiveDirectory = path.join(this.directory(workspace.id), archiveId);
    mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
    const fileIds: string[] = [];

    for (const file of input.files) {
      const fileId = randomUUID();
      const extension = path.extname(file.filename).toLowerCase();
      const storageName = path.posix.join(archiveId, `${fileId}${extension}`);
      writeFileSync(path.join(this.directory(workspace.id), storageName), file.data, {
        mode: 0o600,
      });
      const metadata: WorkspaceFile = {
        id: fileId,
        filename: file.filename,
        relativePath: file.relativePath,
        format: file.format,
        sizeBytes: file.sizeBytes,
        episodeHint: episodeHint(file.relativePath || file.filename),
        languageHint: languageHint(file.filename, file.relativePath),
        storageName,
        source: {
          type: "subhd",
          archiveId,
          subtitleId: input.subtitleId,
          archiveName: input.filename,
        },
      };
      workspace.files.push(metadata);
      fileIds.push(fileId);
    }

    const archive: WorkspaceArchive = {
      id: archiveId,
      subtitleId: input.subtitleId,
      filename: input.filename,
      fileIds,
      createdAt: new Date().toISOString(),
    };
    workspace.archives.push(archive);
    this.touch(workspace);
    return { workspace, archive };
  }

  appendOpenListSubtitle(input: {
    userId: string;
    workspaceId: string;
    jellyfinItemId: string;
    jellyfinItemName: string;
    subtitleRef: string;
    openListPath: string;
    format: string;
    language: string;
    isForced: boolean;
    isHearingImpaired: boolean;
    season?: number;
    episode?: number;
    data: Buffer;
  }): { workspace: SubtitleWorkspace; file: WorkspaceFile; existed: boolean } {
    const workspace = this.require(input.userId, input.workspaceId);
    const existing = workspace.files.find(
      (file) =>
        file.source.type === "jellyfin_openlist" &&
        file.source.jellyfinItemId === input.jellyfinItemId &&
        file.source.subtitleRef === input.subtitleRef,
    );
    if (existing) return { workspace, file: existing, existed: true };

    const fileId = randomUUID();
    const extension = `.${input.format.replace(/^\./, "").toLowerCase()}`;
    const storageDirectory = path.join(this.directory(workspace.id), "openlist");
    mkdirSync(storageDirectory, { recursive: true, mode: 0o700 });
    const storageName = path.posix.join("openlist", `${fileId}${extension}`);
    writeFileSync(
      path.join(this.directory(workspace.id), storageName),
      input.data,
      { mode: 0o600 },
    );
    const filename = path.posix.basename(input.openListPath);
    const file: WorkspaceFile = {
      id: fileId,
      filename,
      relativePath: filename,
      format: input.format.replace(/^\./, "").toLowerCase(),
      sizeBytes: input.data.byteLength,
      episodeHint: input.episode,
      languageHint: input.language || languageHint(filename),
      storageName,
      source: {
        type: "jellyfin_openlist",
        jellyfinItemId: input.jellyfinItemId,
        jellyfinItemName: input.jellyfinItemName,
        subtitleRef: input.subtitleRef,
        openListPath: input.openListPath,
        language: input.language,
        isForced: input.isForced,
        isHearingImpaired: input.isHearingImpaired,
      },
    };
    workspace.files.push(file);
    this.touch(workspace);
    return { workspace, file, existed: false };
  }

  addCaptcha(input: {
    userId: string;
    workspaceId: string;
    subtitleId: string;
    challenge: CaptchaChallenge;
  }): WorkspaceCaptcha {
    const workspace = this.require(input.userId, input.workspaceId);
    const captcha: WorkspaceCaptcha = {
      id: randomUUID(),
      taskCode: this.createTaskCode(workspace),
      subtitleId: input.subtitleId,
      challenge: input.challenge,
      expiresAt: expiresAt(CAPTCHA_LIFETIME_MS),
    };
    workspace.captchas.push(captcha);
    this.touch(workspace);
    return captcha;
  }

  captcha(
    userId: string,
    workspaceId: string,
    captchaId: string,
  ): WorkspaceCaptcha {
    const workspace = this.require(userId, workspaceId);
    const captcha = workspace.captchas.find((candidate) => candidate.id === captchaId);
    if (!captcha || captcha.expiresAt <= new Date().toISOString()) {
      if (captcha) {
        workspace.captchas = workspace.captchas.filter(
          (candidate) => candidate.id !== captchaId,
        );
      }
      throw new Error("字幕验证码不存在或已经过期");
    }
    return captcha;
  }

  captchaByTaskCode(
    userId: string,
    workspaceId: string,
    taskCode: string,
  ): WorkspaceCaptcha {
    const workspace = this.require(userId, workspaceId);
    const normalized = taskCode.trim().toUpperCase();
    const captcha = workspace.captchas.find(
      (candidate) => candidate.taskCode === normalized,
    );
    if (!captcha) throw new Error("字幕验证码任务码不存在或已经过期");
    return this.captcha(userId, workspaceId, captcha.id);
  }

  updateCaptcha(
    userId: string,
    workspaceId: string,
    captchaId: string,
    challenge: CaptchaChallenge,
  ): WorkspaceCaptcha {
    const captcha = this.captcha(userId, workspaceId, captchaId);
    captcha.challenge = challenge;
    captcha.expiresAt = expiresAt(CAPTCHA_LIFETIME_MS);
    this.touch(this.require(userId, workspaceId));
    return captcha;
  }

  removeCaptcha(userId: string, workspaceId: string, captchaId: string): void {
    const workspace = this.require(userId, workspaceId);
    workspace.captchas = workspace.captchas.filter(
      (candidate) => candidate.id !== captchaId,
    );
    this.touch(workspace);
  }

  get(userId: string, id: string): SubtitleWorkspace | undefined {
    const workspace = this.workspaces.get(id);
    if (!workspace || workspace.userId !== userId) return undefined;
    if (workspace.expiresAt <= new Date().toISOString()) {
      this.remove(id);
      return undefined;
    }
    workspace.captchas = workspace.captchas.filter(
      (captcha) => captcha.expiresAt > new Date().toISOString(),
    );
    return workspace;
  }

  require(userId: string, id: string): SubtitleWorkspace {
    const workspace = this.get(userId, id);
    if (!workspace) throw new Error("字幕工作区不存在或已经过期");
    return workspace;
  }

  readFileById(userId: string, id: string, fileId: string): {
    metadata: WorkspaceFile;
    data: Buffer;
  } {
    const { metadata, filePath } = this.resolveFile(userId, id, fileId);
    return {
      metadata,
      data: readFileSync(filePath),
    };
  }

  fileById(userId: string, id: string, fileId: string): WorkspaceFile {
    return this.resolveFile(userId, id, fileId).metadata;
  }

  openFileById(userId: string, id: string, fileId: string): {
    metadata: WorkspaceFile;
    stream: ReadStream;
    sizeBytes: number;
  } {
    const { metadata, filePath } = this.resolveFile(userId, id, fileId);
    return {
      metadata,
      stream: createReadStream(filePath),
      sizeBytes: statSync(filePath).size,
    };
  }

  async fileDigestById(
    userId: string,
    id: string,
    fileId: string,
  ): Promise<string> {
    const { filePath } = this.resolveFile(userId, id, fileId);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex");
  }

  createPlacementPlan(input: {
    userId: string;
    workspaceId: string;
    mappings: Array<Omit<WorkspacePlacementMapping, "id">>;
  }): WorkspacePlacementPlan {
    const workspace = this.require(input.userId, input.workspaceId);
    const plan: WorkspacePlacementPlan = {
      id: randomUUID(),
      mappings: input.mappings.map((mapping) => ({
        ...mapping,
        id: randomUUID(),
      })),
      executing: false,
      createdAt: new Date().toISOString(),
    };
    workspace.placementPlans.push(plan);
    this.touch(workspace);
    return plan;
  }

  placementPlan(
    userId: string,
    workspaceId: string,
    planId: string,
  ): WorkspacePlacementPlan {
    const workspace = this.require(userId, workspaceId);
    const plan = workspace.placementPlans.find(
      (candidate) => candidate.id === planId,
    );
    if (!plan) throw new Error("字幕放置计划不存在或已经过期");
    return plan;
  }

  beginPlacementPlan(
    userId: string,
    workspaceId: string,
    planId: string,
  ): WorkspacePlacementPlan {
    const plan = this.placementPlan(userId, workspaceId, planId);
    if (plan.executing) throw new Error("字幕放置计划正在执行");
    plan.executing = true;
    this.touch(this.require(userId, workspaceId));
    return plan;
  }

  completePlacementMapping(
    userId: string,
    workspaceId: string,
    planId: string,
    mappingId: string,
  ): void {
    const mapping = this.placementPlan(userId, workspaceId, planId).mappings.find(
      (candidate) => candidate.id === mappingId,
    );
    if (!mapping) throw new Error("字幕放置映射不存在");
    mapping.completedAt = new Date().toISOString();
    mapping.lastError = undefined;
    this.touch(this.require(userId, workspaceId));
  }

  markPlacementUploaded(
    userId: string,
    workspaceId: string,
    planId: string,
    mappingId: string,
  ): void {
    const mapping = this.placementPlan(userId, workspaceId, planId).mappings.find(
      (candidate) => candidate.id === mappingId,
    );
    if (!mapping) throw new Error("字幕放置映射不存在");
    mapping.uploadedAt ??= new Date().toISOString();
    mapping.lastError = undefined;
    this.touch(this.require(userId, workspaceId));
  }

  failPlacementMapping(
    userId: string,
    workspaceId: string,
    planId: string,
    mappingId: string,
    error: string,
  ): void {
    const mapping = this.placementPlan(userId, workspaceId, planId).mappings.find(
      (candidate) => candidate.id === mappingId,
    );
    if (!mapping) throw new Error("字幕放置映射不存在");
    mapping.lastError = error;
    this.touch(this.require(userId, workspaceId));
  }

  finishPlacementPlan(
    userId: string,
    workspaceId: string,
    planId: string,
  ): void {
    const plan = this.placementPlan(userId, workspaceId, planId);
    plan.executing = false;
    this.touch(this.require(userId, workspaceId));
  }

  processingEntry(
    userId: string,
    workspaceId: string,
    fileId: string,
  ): WorkspaceProcessingEntry {
    const workspace = this.require(userId, workspaceId);
    const file = this.fileById(userId, workspaceId, fileId);
    if (file.source.type !== "jellyfin_openlist") {
      throw new Error("大陆用词转换只处理从 OpenList 导入的已有字幕");
    }
    let entry = workspace.processingEntries.find(
      (candidate) =>
        candidate.fileId === fileId &&
        candidate.operation === "mainland_wording" &&
        candidate.outputLanguage === "chs",
    );
    if (!entry) {
      const now = new Date().toISOString();
      entry = {
        id: randomUUID(),
        fileId,
        operation: "mainland_wording",
        outputLanguage: "chs",
        state: "pending",
        beforeSubtitleRefs: [],
        createdAt: now,
        updatedAt: now,
      };
      workspace.processingEntries.push(entry);
      this.touch(workspace);
    }
    return entry;
  }

  beginProcessing(
    userId: string,
    workspaceId: string,
    fileId: string,
  ): WorkspaceProcessingEntry {
    const entry = this.processingEntry(userId, workspaceId, fileId);
    if (entry.state === "processing") throw new Error("字幕文件正在处理");
    if (entry.state !== "completed") entry.state = "processing";
    entry.lastError = undefined;
    entry.updatedAt = new Date().toISOString();
    this.touch(this.require(userId, workspaceId));
    return entry;
  }

  markProcessingUploaded(
    userId: string,
    workspaceId: string,
    fileId: string,
    input: {
      beforeSubtitleRefs: string[];
      eligibleEvents: number;
      rewrittenEvents: number;
      rewrittenSegments: number;
    },
  ): WorkspaceProcessingEntry {
    const entry = this.processingEntry(userId, workspaceId, fileId);
    entry.state = "uploaded";
    entry.beforeSubtitleRefs = [...input.beforeSubtitleRefs];
    entry.eligibleEvents = input.eligibleEvents;
    entry.rewrittenEvents = input.rewrittenEvents;
    entry.rewrittenSegments = input.rewrittenSegments;
    entry.uploadedAt ??= new Date().toISOString();
    entry.updatedAt = new Date().toISOString();
    entry.lastError = undefined;
    this.touch(this.require(userId, workspaceId));
    return entry;
  }

  completeProcessing(
    userId: string,
    workspaceId: string,
    fileId: string,
    outputSubtitleRef?: string,
  ): WorkspaceProcessingEntry {
    const entry = this.processingEntry(userId, workspaceId, fileId);
    entry.state = "completed";
    entry.outputSubtitleRef = outputSubtitleRef;
    entry.completedAt ??= new Date().toISOString();
    entry.updatedAt = new Date().toISOString();
    entry.lastError = undefined;
    this.touch(this.require(userId, workspaceId));
    return entry;
  }

  failProcessing(
    userId: string,
    workspaceId: string,
    fileId: string,
    error: string,
  ): WorkspaceProcessingEntry {
    const entry = this.processingEntry(userId, workspaceId, fileId);
    entry.state = "failed";
    entry.lastError = error;
    entry.updatedAt = new Date().toISOString();
    this.touch(this.require(userId, workspaceId));
    return entry;
  }

  remove(id: string): void {
    this.workspaces.delete(id);
    rmSync(this.directory(id), { recursive: true, force: true });
  }

  deleteExpired(): number {
    const now = new Date().toISOString();
    const expired = [...this.workspaces.values()].filter(
      (workspace) => workspace.expiresAt <= now,
    );
    for (const workspace of expired) this.remove(workspace.id);
    return expired.length;
  }

  private touch(workspace: SubtitleWorkspace): void {
    workspace.updatedAt = new Date().toISOString();
    workspace.expiresAt = expiresAt(WORKSPACE_LIFETIME_MS);
  }

  private directory(id: string): string {
    return path.join(this.root, id);
  }

  private resolveFile(
    userId: string,
    id: string,
    fileId: string,
  ): { metadata: WorkspaceFile; filePath: string } {
    const workspace = this.require(userId, id);
    const metadata = workspace.files.find((file) => file.id === fileId);
    if (!metadata) throw new Error(`字幕文件 ID ${fileId} 不存在`);
    return {
      metadata,
      filePath: path.join(this.directory(id), metadata.storageName),
    };
  }

  private createTaskCode(workspace: SubtitleWorkspace): string {
    let code = "";
    do {
      code = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    } while (workspace.captchas.some((captcha) => captcha.taskCode === code));
    return code;
  }
}

function expiresAt(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString();
}
