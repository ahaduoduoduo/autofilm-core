import { describe, expect, it } from "vitest";
import type { ToolDependencies } from "../tool-types.js";
import { createOpenListTools } from "./openlist.js";

function taskStoreRecorder(created: Array<Record<string, unknown>>) {
  let stored: Record<string, unknown> | undefined;
  return {
    create(input: Record<string, unknown>) {
      created.push(input);
      stored = {
        id: "local-task",
        userId: input.userId ?? null,
        type: input.type,
        title: input.title,
        state: input.state ?? "queued",
        progress: null,
        statusText: "",
        externalId: input.externalId ?? null,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      };
      return stored;
    },
    get(id: string) {
      return id === stored?.id ? stored : undefined;
    },
    update(id: string, input: Record<string, unknown>) {
      if (!stored || id !== stored.id) throw new Error("Task not found");
      stored = { ...stored, ...input };
      return stored;
    },
  };
}

describe("OpenList download tools", () => {
  it("computes a multi-season destination instead of accepting one from AI", async () => {
    const createdDirectories: string[] = [];
    const submissions: Array<{ path: string; url: string }> = [];
    const createdTasks: Array<Record<string, unknown>> = [];
    const deps = {
      userId: "user-1",
      notificationTarget: {
        channel: "wechat",
        providerInstanceId: "wechat-main",
        targetId: "user-1@wechat",
      },
      openList: {
        mediaLibraryRoots() {
          return {
            movie: "/115/nvideo/movie",
            tv: "/115/nvideo/tv",
          };
        },
        instantOfflinePolicy() {
          return { enabled: true, timeoutMs: 40_000 };
        },
        async mkdir(path: string) {
          createdDirectories.push(path);
        },
        async startOfflineDownload(input: { path: string; url: string }) {
          submissions.push(input);
          return [{
            id: "remote-1",
            name: "Example.S01-S03",
            state: 1,
            status: "running",
            progress: 0,
            total_bytes: 100,
            error: "",
            provider_task_id: "provider-1",
            provider_submitted_at: new Date().toISOString(),
          }];
        },
      },
      tmdb: {
        async details(tmdbId: number, mediaType: "movie" | "tv") {
          return {
            id: tmdbId,
            mediaType,
            title: "示例剧",
            originalTitle: "Example Show",
            englishTitle: "Example Show",
            overview: "",
            releaseDate: "2026-01-01",
            posterPath: "",
          };
        },
      },
      tasks: taskStoreRecorder(createdTasks),
    } as unknown as ToolDependencies;
    const tool = createOpenListTools(deps).find(
      (item) => item.definition.name === "start_offline_download",
    )!;

    const result = await tool.execute({
      magnet_uri: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
      fallback_candidate_ids: [],
      fallback_magnet_uris: [],
      media_type: "tv",
      tmdb_id: 123,
      seasons: [1, 2, 3],
      title: "Example S01-S03",
    });

    expect(createdDirectories).toEqual(["/115/nvideo/tv/Example.Show"]);
    expect(submissions).toEqual([{
      path: "/115/nvideo/tv/Example.Show",
      url:
        `magnet:?xt=urn:btih:${"a".repeat(40)}` +
        `&dn=${encodeURIComponent("Example S01-S03")}`,
    }]);
    expect(createdTasks[0]?.metadata).toMatchObject({
      destination: "/115/nvideo/tv/Example.Show",
      jellyfinRefreshPath: "/115/nvideo/tv/Example.Show",
      jellyfinProviderIds: { Tmdb: "123" },
      media: {
        type: "tv",
        tmdbId: 123,
        seasons: [1, 2, 3],
        isMultiSeason: true,
      },
      instantOfflinePolicy: {
        enabled: true,
        timeoutMs: 40_000,
      },
      downloadCandidates: [{
        id: expect.any(String),
        title: "用户提供的磁力资源",
        magnetUri: expect.stringContaining("magnet:?xt=urn:btih:"),
      }],
      notificationTarget: {
        channel: "wechat",
        providerInstanceId: "wechat-main",
        targetId: "user-1@wechat",
      },
      completionContinuation: {
        state: "pending",
        attempts: 0,
      },
    });
    expect(
      (
        createdTasks[0]?.metadata as Record<string, unknown>
      ).completionContinuation,
    ).toMatchObject({
      workflowId: expect.any(String),
      nextAttemptAt: expect.any(String),
    });
    expect(result).toMatchObject({
      submissionStatus: "succeeded",
      message: "离线下载提交成功",
      taskId: "local-task",
      title: "Example S01-S03",
      destination: "/115/nvideo/tv/Example.Show",
    });
    expect(result).not.toHaveProperty("state");
  });

  it("resolves Jackett candidate IDs and submits only their magnet", async () => {
    const submitted: Array<{ path: string; url: string }> = [];
    const createdTasks: Array<Record<string, unknown>> = [];
    const magnetUri = `magnet:?xt=urn:btih:${"c".repeat(40)}&dn=Jackett`;
    const deps = {
      userId: "user-1",
      jackett: {
        async resolveCandidate(id: string) {
          expect(id).toBe("release-main");
          return {
            id,
            title: "Jackett.Original.Release.Title",
            magnetUri,
          };
        },
      },
      openList: {
        mediaLibraryRoots() {
          return {
            movie: "/115/nvideo/movie",
            tv: "/115/nvideo/tv",
          };
        },
        instantOfflinePolicy() {
          return { enabled: true, timeoutMs: 40_000 };
        },
        async mkdir() {},
        async startOfflineDownload(input: { path: string; url: string }) {
          submitted.push(input);
          return [{
            id: "remote-main",
            name: "Jackett.Original.Release.Title",
            state: 1,
            status: "running",
            progress: 0,
            total_bytes: 100,
            error: "",
            provider_task_id: "provider-main",
            provider_submitted_at: new Date().toISOString(),
          }];
        },
      },
      tmdb: {
        async details(tmdbId: number, mediaType: "movie" | "tv") {
          return {
            id: tmdbId,
            mediaType,
            title: "示例电影",
            originalTitle: "Example Movie",
            englishTitle: "Example Movie",
            overview: "",
            releaseDate: "2026-01-01",
            posterPath: "",
          };
        },
      },
      tasks: taskStoreRecorder(createdTasks),
    } as unknown as ToolDependencies;
    const tool = createOpenListTools(deps).find(
      (item) => item.definition.name === "start_offline_download",
    )!;

    const result = await tool.execute({
      release_candidate_id: "release-main",
      fallback_candidate_ids: [],
      fallback_magnet_uris: [],
      media_type: "movie",
      tmdb_id: 123,
      seasons: [],
      title: "Example Movie",
    });

    expect(submitted).toEqual([{
      path: "/115/nvideo/movie/2026-07",
      url: magnetUri,
    }]);
    expect(createdTasks[0]?.metadata).toMatchObject({
      sourceCandidateId: "release-main",
      downloadCandidates: [{
        id: "release-main",
        title: "Jackett.Original.Release.Title",
        magnetUri,
      }],
    });
    expect(result).toMatchObject({
      submissionStatus: "succeeded",
      message: "离线下载提交成功",
      title: "Example Movie",
    });
  });

  it("submits a fallback only after the user selects a saved candidate", async () => {
    const submissions: Array<{ path: string; url: string }> = [];
    let updated: Record<string, unknown> | undefined;
    const task = {
      id: "local-waiting",
      userId: "user-1",
      type: "offline-download",
      title: "Example",
      state: "waiting",
      progress: null,
      statusText: "等待用户选择备用资源",
      externalId: null,
      metadata: {
        destination: "/115/nvideo/movie/2026-07",
        downloadCandidates: [
          {
            id: "candidate-first",
            title: "First Release",
            magnetUri: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
          },
          {
            id: "candidate-second",
            title: "Second Release",
            magnetUri: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
          },
        ],
        attemptIndex: 0,
        awaitingFallbackSelection: true,
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      completedAt: null,
    };
    let stored = task;
    const deps = {
      userId: "user-1",
      openList: {
        async startOfflineDownload(input: { path: string; url: string }) {
          submissions.push(input);
          return [{
            id: "remote-second",
            name: "Second",
            state: 1,
            status: "running",
            progress: 0,
            total_bytes: 100,
            error: "",
            provider_task_id: "provider-second",
            provider_submitted_at: new Date().toISOString(),
          }];
        },
      },
      tasks: {
        get(id: string) {
          return id === stored.id ? stored : undefined;
        },
        update(id: string, input: Record<string, unknown>) {
          updated = { id, ...input };
          stored = { ...stored, ...input } as typeof task;
          return stored;
        },
      },
    } as unknown as ToolDependencies;
    const tool = createOpenListTools(deps).find(
      (item) => item.definition.name === "resume_offline_download",
    )!;

    const result = await tool.execute({
      task_id: task.id,
      candidate_id: "candidate-second",
    });

    expect(submissions).toEqual([{
      path: "/115/nvideo/movie/2026-07",
      url: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
    }]);
    expect(updated).toMatchObject({
      id: task.id,
      externalId: "remote-second",
      metadata: {
        sourceCandidateId: "candidate-second",
        attemptIndex: 1,
        remoteName: "Second",
      },
    });
    expect(stored.state).toBe("running");
    expect(
      (updated?.metadata as Record<string, unknown>)
        .awaitingFallbackSelection,
    ).toBeUndefined();
    expect(result).toMatchObject({
      submissionStatus: "succeeded",
      message: "离线下载提交成功",
      title: "Example",
    });
    expect(result).not.toHaveProperty("state");
  });

  it("does not expose a model-controlled destination parameter", () => {
    const placeholder = {} as never;
    const tools = createOpenListTools({
      userId: "user-1",
      openList: placeholder,
      tmdb: placeholder,
      tasks: placeholder,
    } as unknown as ToolDependencies);
    for (const name of ["start_offline_download", "start_batch_download"]) {
      const definition = tools.find((tool) => tool.definition.name === name)!
        .definition;
      const parameters = definition.parameters as {
        properties: Record<string, unknown>;
      };
      expect(parameters.properties.destination).toBeUndefined();
      expect(parameters.properties.media_type).toBeDefined();
      expect(parameters.properties.tmdb_id).toBeDefined();
      expect(parameters.properties.seasons).toBeDefined();
      if (name === "start_offline_download") {
        expect(parameters.properties.release_candidate_id).toBeDefined();
        expect(parameters.properties.magnet_uri).toBeDefined();
        expect(parameters.properties.url).toBeUndefined();
      }
    }
  });
});
