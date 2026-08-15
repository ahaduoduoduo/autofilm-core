import { describe, expect, it } from "vitest";
import { SubtitleDocument } from "./subtitle-document.js";

describe("subtitle document", () => {
  it("changes only Chinese ASS segments and preserves English, tags and timing", () => {
    const source = `[Script Info]\r\nTitle: Example\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}我有在考虑这件事\\N{\\fnArial}I've been thinking about it.\r\n`;
    const document = SubtitleDocument.parse("episode.ass", source)!;

    expect(document.events[0]).toMatchObject({
      id: 0,
      kind: "dialogue",
      plainText: "我有在考虑这件事\nI've been thinking about it.",
      chineseSegments: [{ index: 0, text: "我有在考虑这件事" }],
    });
    const result = document.replaceChineseSegments(
      new Map([[0, new Map([[0, "我一直在考虑这件事"]])]]),
    );

    expect(result).toBe(
      source.replace("我有在考虑这件事", "我一直在考虑这件事"),
    );
    expect(result).toContain("0:00:01.00,0:00:03.00,Default");
    expect(result).toContain("{\\an8}");
    expect(result).toContain("\\N{\\fnArial}I've been thinking about it.");
  });

  it("protects English in mixed SRT cues and skips karaoke or Japanese lines", () => {
    const srt = `1\n00:00:01,000 --> 00:00:03,000\n我有在使用 iPhone\nI am using an iPhone.\n\n2\n00:00:04,000 --> 00:00:05,000\n今日は晴れです`;
    const document = SubtitleDocument.parse("episode.srt", srt)!;

    expect(document.events[0]?.chineseSegments).toEqual([
      { index: 0, text: "我有在使用" },
    ]);
    expect(document.events[1]?.chineseSegments).toEqual([]);
    expect(
      document.replaceChineseSegments(
        new Map([[0, new Map([[0, "我正在使用"]])]]),
      ),
    ).toBe(srt.replace("我有在使用", "我正在使用"));

    const ass = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Song,,0,0,0,,{\\k20}你{\\k20}好`;
    expect(SubtitleDocument.parse("song.ass", ass)?.events[0]?.chineseSegments).toEqual(
      [],
    );
  });

  it("removes selected events while retaining standard SRT numbering", () => {
    const source = `1\n00:00:01,000 --> 00:00:02,000\n广告\n\n2\n00:00:03,000 --> 00:00:04,000\n正片`;
    const document = SubtitleDocument.parse("episode.srt", source)!;
    expect(document.removeEvents(new Set([0]))).toBe(
      `1\n00:00:03,000 --> 00:00:04,000\n正片`,
    );

    const vtt = `WEBVTT\n\n17\n00:00:01.000 --> 00:00:02.000\n广告\n\n42\n00:00:03.000 --> 00:00:04.000\n正片`;
    expect(SubtitleDocument.parse("episode.vtt", vtt)?.removeEvents(new Set([0])))
      .toBe(`WEBVTT\n\n42\n00:00:03.000 --> 00:00:04.000\n正片`);
  });
});
