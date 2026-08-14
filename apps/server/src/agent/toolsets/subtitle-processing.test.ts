import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubtitleReference } from "../../subtitles/references.js";
import { SubtitleWorkspaceStore } from "../../subtitles/workspace-store.js";
import type { ToolDependencies } from "../tool-types.js";
import { createSubtitleProcessingTools } from "./subtitle-processing.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("existing OpenList subtitle processing", () => {
  it("imports several episodes into one workspace and creates new chs subtitles", async () => {
    const fixture = processingFixture();
    const tools = createSubtitleProcessingTools(fixture.dependencies);
    const imported = (await tool(tools, "import_openlist_subtitles").execute({
      workspace_id: fixture.workspaceId,
      targets: fixture.targets,
    })) as {
      status: string;
      results: Array<{ workspaceFileId: string }>;
    };

    expect(imported.status).toBe("success");
    expect(imported.results).toHaveLength(2);
    expect(fixture.downloadObject).toHaveBeenCalledTimes(2);

    const fileIds = imported.results.map((result) => result.workspaceFileId);
    const processed = (await tool(tools, "process_subtitle_workspace").execute({
      workspace_id: fixture.workspaceId,
      workspace_file_ids: fileIds,
      operations: [{ type: "mainland_wording" }],
    })) as {
      status: string;
      succeeded: number;
      results: Array<Record<string, unknown>>;
    };

    expect(processed).toMatchObject({ status: "success", succeeded: 2 });
    expect(processed.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          language: "chs",
          uploaded: true,
          sourcePreserved: true,
        }),
      ]),
    );
    expect(fixture.process).toHaveBeenCalledTimes(2);
    expect(fixture.uploadSubtitle).toHaveBeenCalledTimes(2);
    expect(
      fixture.process.mock.calls.map((call) => call[2]),
    ).toEqual([
      [{ type: "mainland_wording" }],
      [{ type: "mainland_wording" }],
    ]);
    for (const item of fixture.items.values()) {
      expect(item.MediaStreams).toHaveLength(2);
      expect(item.MediaStreams[0]?.Language).toBe("cht");
      expect(item.MediaStreams[1]?.Language).toBe("chs");
    }

    const repeated = (await tool(tools, "process_subtitle_workspace").execute({
      workspace_id: fixture.workspaceId,
      workspace_file_ids: fileIds,
      operations: [{ type: "mainland_wording" }],
    })) as { status: string; results: Array<Record<string, unknown>> };
    expect(repeated.status).toBe("success");
    expect(repeated.results.every((result) => result.alreadyCompleted)).toBe(true);
    expect(fixture.process).toHaveBeenCalledTimes(2);
    expect(fixture.uploadSubtitle).toHaveBeenCalledTimes(2);
  });

  it("skips completed files and retries only the failed file", async () => {
    const fixture = processingFixture({ failUploadOnceFor: "episode-2" });
    const tools = createSubtitleProcessingTools(fixture.dependencies);
    const imported = (await tool(tools, "import_openlist_subtitles").execute({
      workspace_id: fixture.workspaceId,
      targets: fixture.targets,
    })) as { results: Array<{ workspaceFileId: string }> };
    const fileIds = imported.results.map((result) => result.workspaceFileId);

    const first = (await tool(tools, "process_subtitle_workspace").execute({
      workspace_id: fixture.workspaceId,
      workspace_file_ids: fileIds,
      operations: [{ type: "mainland_wording" }],
    })) as { status: string; succeeded: number; failed: number };
    expect(first).toMatchObject({ status: "partial", succeeded: 1, failed: 1 });

    const second = (await tool(tools, "process_subtitle_workspace").execute({
      workspace_id: fixture.workspaceId,
      workspace_file_ids: fileIds,
      operations: [{ type: "mainland_wording" }],
    })) as { status: string; succeeded: number; failed: number };
    expect(second).toMatchObject({ status: "success", succeeded: 2, failed: 0 });
    expect(fixture.process).toHaveBeenCalledTimes(3);
    expect(fixture.uploadSubtitle).toHaveBeenCalledTimes(3);
  });
});

function processingFixture(options?: { failUploadOnceFor?: string }): {
  dependencies: ToolDependencies;
  workspaceId: string;
  targets: Array<{ jellyfin_item_id: string; subtitle_ref: string }>;
  items: Map<string, TestItem>;
  downloadObject: ReturnType<typeof vi.fn>;
  process: ReturnType<typeof vi.fn>;
  uploadSubtitle: ReturnType<typeof vi.fn>;
} {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "autofilm-processing-"));
  directories.push(dataDir);
  const store = new SubtitleWorkspaceStore(dataDir);
  const workspace = store.create("user-1");
  const items = new Map<string, TestItem>();
  const targets = [1, 2].map((episode) => {
    const id = `episode-${episode}`;
    const stream: Record<string, unknown> = {
      Index: 3,
      Type: "Subtitle",
      IsExternal: true,
      Path: `openlist:///Show/Show.S01E0${episode}.cht.ass`,
      Codec: "ass",
      Language: "cht",
      IsForced: false,
      IsHearingImpaired: false,
    };
    items.set(id, {
      Id: id,
      Name: `第 ${episode} 集`,
      Type: "Episode",
      Path: `openlist:///Show/Show.S01E0${episode}.mkv`,
      SeriesName: "Show",
      ParentIndexNumber: 1,
      IndexNumber: episode,
      MediaStreams: [stream],
    });
    return {
      jellyfin_item_id: id,
      subtitle_ref: createSubtitleReference(id, stream),
    };
  });
  const downloadObject = vi.fn(async (remotePath: string) => ({
    object: { path: remotePath },
    data: Buffer.from(
      "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
        "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,搭計程車\\Ntake a taxi\n",
      "utf8",
    ),
  }));
  const process = vi.fn(async (_filename: string, data: Buffer) => ({
    data: Buffer.from(data.toString("utf8").replace("搭計程車", "坐出租车")),
    operations: [
      {
        type: "mainland_wording",
        summary: "converted",
        eligibleEvents: 1,
        rewrittenEvents: 1,
        rewrittenSegments: 1,
      },
    ],
  }));
  let failed = false;
  const uploadSubtitle = vi.fn(async (input: { itemId: string; language: string }) => {
    if (input.itemId === options?.failUploadOnceFor && !failed) {
      failed = true;
      throw new Error("temporary upload failure");
    }
    const item = items.get(input.itemId)!;
    item.MediaStreams.push({
      Index: item.MediaStreams.length + 3,
      Type: "Subtitle",
      IsExternal: true,
      Path: `openlist:///Show/${input.itemId}.chs.ass`,
      Codec: "ass",
      Language: input.language,
      IsForced: false,
      IsHearingImpaired: false,
    });
  });
  const dependencies = {
    userId: "user-1",
    subtitleWorkspaces: store,
    openList: { downloadObject },
    subtitleProcessor: { process },
    jellyfin: {
      item: async (id: string) => items.get(id),
      uploadSubtitle,
    },
  } as unknown as ToolDependencies;
  return {
    dependencies,
    workspaceId: workspace.id,
    targets,
    items,
    downloadObject,
    process,
    uploadSubtitle,
  };
}

function tool(
  tools: ReturnType<typeof createSubtitleProcessingTools>,
  name: string,
) {
  return tools.find((candidate) => candidate.definition.name === name)!;
}

interface TestItem {
  Id: string;
  Name: string;
  Type: string;
  Path: string;
  SeriesName: string;
  ParentIndexNumber: number;
  IndexNumber: number;
  MediaStreams: Array<Record<string, unknown>>;
}
