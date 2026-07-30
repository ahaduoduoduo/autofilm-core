import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubHDClient } from "../integrations/subhd.js";
import { analyzeAss, modifyAss } from "./ass-style.js";
import type { CaptchaRecognizer } from "./captcha-recognizer.js";
import { SubtitleDownloadService } from "./download-service.js";
import { decodeSubtitleText } from "./extract.js";
import {
  createSubtitleReference,
  resolveSubtitleReference,
} from "./references.js";
import { SubtitleWorkspaceStore } from "./workspace-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("subtitle workspaces", () => {
  it("aggregates archives and isolates concurrent captcha state by user", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "autofilm-subtitles-"));
    directories.push(dataDir);
    const store = new SubtitleWorkspaceStore(dataDir);
    const workspace = store.create("user-1");
    const captcha = store.addCaptcha({
      userId: "user-1",
      workspaceId: workspace.id,
      subtitleId: "sub-1",
      challenge: {
        sessionId: "session-1",
        svgContent: "<svg></svg>",
        sid: "sub-1",
        cookies: "session=one-time",
        downloadPageUrl: "https://subhd.tv/down/sub-1",
      },
    });
    expect(
      store.captcha("user-1", workspace.id, captcha.id).challenge.sid,
    ).toBe("sub-1");
    expect(captcha.taskCode).toMatch(/^[A-F0-9]{6}$/);
    expect(
      store.captchaByTaskCode(
        "user-1",
        workspace.id,
        captcha.taskCode.toLowerCase(),
      ).id,
    ).toBe(captcha.id);
    expect(store.get("user-2", workspace.id)).toBeUndefined();

    store.appendArchive({
      userId: "user-1",
      workspaceId: workspace.id,
      subtitleId: "sub-1",
      filename: "season-one.zip",
      files: [
        {
          filename: "episode.ass",
          relativePath: "chs/Show.S01E01.ass",
          format: "ass",
          sizeBytes: 4,
          data: Buffer.from("test"),
        },
      ],
    });
    store.appendArchive({
      userId: "user-1",
      workspaceId: workspace.id,
      subtitleId: "sub-2",
      filename: "episode-two.rar",
      files: [
        {
          filename: "Show.S01E02.chs&eng.srt",
          relativePath: "S01/Show.S01E02.chs&eng.srt",
          format: "srt",
          sizeBytes: 6,
          data: Buffer.from("second"),
        },
      ],
    });
    const aggregated = store.require("user-1", workspace.id);
    expect(aggregated.archives).toHaveLength(2);
    expect(new Set(aggregated.files.map((file) => file.id)).size).toBe(2);
    expect(aggregated.files[1]?.episodeHint).toBe(2);
    expect(aggregated.files[1]?.languageHint).toBe("chs+eng");
    expect(
      store
        .readFileById("user-1", workspace.id, aggregated.files[1]!.id)
        .data.toString(),
    ).toBe("second");
    const opened = store.openFileById(
      "user-1",
      workspace.id,
      aggregated.files[1]!.id,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("second");
    expect(
      await store.fileDigestById(
        "user-1",
        workspace.id,
        aggregated.files[1]!.id,
      ),
    ).toBe(createHash("sha256").update("second").digest("hex"));
  });
});

describe("ASS style operations", () => {
  const fixture = `[Script Info]
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Alignment, MarginV
Style: Dialogue,Arial,42,&H00FFFFFF,&H00000000,2,20

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Dialogue,,0,0,0,,{\\pos(640,680)}你好
`;

  it("analyzes and modifies a selected dialogue style", () => {
    const analysis = analyzeAss(fixture);
    expect(analysis.playResX).toBe(1280);
    expect(analysis.styles[0]?.usageCount).toBe(1);
    const modified = modifyAss(fixture, {
      styleNames: ["Dialogue"],
      changes: { fontSize: 48 },
      moveToBottom: true,
    });
    expect(modified).toContain("Dialogue,Arial,48");
    expect(modified).not.toContain("\\pos");
  });

  it("preserves non-dialogue effects when expanding black bars", () => {
    const complex = fixture
      .replace(
        "Style: Dialogue,Arial,42,&H00FFFFFF,&H00000000,2,20",
        "Style: Dialogue,Arial,42,&H00FFFFFF,&H00000000,2,20\n" +
          "Style: Sign,Arial,30,&H00FFFFFF,&H00000000,8,15",
      )
      .replace(
        "Dialogue: 0,0:00:01.00,0:00:03.00,Dialogue,,0,0,0,,{\\pos(640,680)}你好",
        "Dialogue: 0,0:00:01.00,0:00:03.00,Dialogue,,0,0,0,,{\\i1\\fad(100,100)\\fs20\\pos(640,680)}你好\n" +
          "Dialogue: 0,0:00:01.00,0:00:03.00,Sign,,0,0,0,,{\\org(10,20)\\clip(0,0,100,100)}招牌",
      )
      .replace("PlayResY: 720", "PlayResY: 536");
    const modified = modifyAss(complex, {
      styleNames: ["Dialogue"],
      changes: { fontSize: 48 },
      moveToBlackBar: true,
      inlineMode: "remove",
    });
    expect(modified).toContain("PlayResY: 720");
    expect(modified).toContain("Sign,Arial,30,&H00FFFFFF,&H00000000,8,107");
    expect(modified).toContain("\\org(10,112)");
    expect(modified).toContain("\\clip(0,92,100,192)");
    expect(modified).toContain("\\i1\\fad(100,100)");
    expect(modified).not.toContain("\\fs20");
  });
});

describe("subtitle encoding", () => {
  it("normalizes GBK and GB2312-compatible text through GB18030", () => {
    expect(decodeSubtitleText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe(
      "中文",
    );
  });
});

describe("subtitle download concurrency", () => {
  it("does not serialize independent captcha recognition contexts", async () => {
    let recognizing = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subhd = {
      download: async (subtitleId: string) => ({
        captcha: {
          sessionId: `session-${subtitleId}`,
          svgContent: `<svg>${subtitleId}</svg>`,
          sid: subtitleId,
          cookies: `session=${subtitleId}`,
          downloadPageUrl: `https://subhd.tv/down/${subtitleId}`,
        },
      }),
      submitCaptcha: async () => ({
        data: Buffer.from("subtitle"),
        filename: "subtitle.ass",
      }),
    } as unknown as SubHDClient;
    const recognizer = {
      recognize: async () => {
        recognizing += 1;
        await gate;
        return "1234";
      },
    } as unknown as CaptchaRecognizer;
    const service = new SubtitleDownloadService(subhd, recognizer);

    const downloads = Promise.all([
      service.download("subtitle-1"),
      service.download("subtitle-2"),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(recognizing).toBe(2);
    release();
    const results = await downloads;
    expect(results.every((result) => result.filename === "subtitle.ass")).toBe(
      true,
    );
  });
});

describe("Jellyfin subtitle references", () => {
  it("survives stream renumbering and rejects changed files", () => {
    const original = {
      Index: 3,
      Type: "Subtitle",
      IsExternal: true,
      Path: "openlist:///movie/Movie.zh.ass",
      Codec: "ass",
      Language: "zh",
    };
    const reference = createSubtitleReference("movie-1", original);
    const renumbered = {
      Id: "movie-1",
      Name: "Movie",
      Type: "Movie",
      MediaStreams: [{ ...original, Index: 8 }],
    };

    expect(resolveSubtitleReference(renumbered, reference).index).toBe(8);
    expect(() =>
      resolveSubtitleReference(
        {
          ...renumbered,
          MediaStreams: [
            {
              ...original,
              Index: 8,
              Path: "openlist:///movie/Other.zh.ass",
            },
          ],
        },
        reference,
      ),
    ).toThrow("已经变化");
  });
});
