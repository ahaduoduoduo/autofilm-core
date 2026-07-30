import path from "node:path";
import { createAiClient } from "../ai/client.js";
import type { ConfigStore } from "../db/config-store.js";
import type { PromptStore } from "../db/prompt-store.js";

export interface CleanResult {
  data: Buffer;
  removed: number;
  summary: string;
}

interface CleanCandidate {
  id: number;
  sourceIndex: number;
  promptLine: string;
}

interface ParsedSubtitle {
  candidates: CleanCandidate[];
  remove(sourceIndexes: Set<number>): string;
}

export class SubtitleCleaner {
  constructor(
    private readonly configs: ConfigStore,
    private readonly prompts: PromptStore,
  ) {}

  async clean(filename: string, data: Buffer): Promise<CleanResult> {
    const extension = path.extname(filename).toLowerCase();
    if (![".ass", ".ssa", ".srt", ".vtt"].includes(extension)) {
      return {
        data,
        removed: 0,
        summary: "SUP 或其他二进制字幕不执行广告清理",
      };
    }

    const content = data.toString("utf8");
    const parsed =
      extension === ".ass" || extension === ".ssa"
        ? parseAss(content)
        : parseTimedText(content, extension === ".vtt");
    if (parsed.candidates.length === 0) {
      return { data, removed: 0, summary: "字幕中没有可分析的事件" };
    }

    const model = this.configs.defaultModel();
    const provider = model ? this.configs.provider(model.providerId) : undefined;
    if (!model || !provider || !provider.enabled) {
      return {
        data,
        removed: 0,
        summary: "没有可用 AI 模型，已保留原字幕",
      };
    }

    try {
      const client = createAiClient(provider.protocol, {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        headers: provider.customHeaders,
      });
      const response = await client.generate({
        model: model.model,
        messages: [
          {
            role: "system",
            content: this.prompts.get("subtitle.cleaner"),
          },
          {
            role: "user",
            content:
              `文件：${filename}\n以下是字幕文件的全部事件。` +
              "请判断需要删除的广告、字幕组署名或水印：\n\n" +
              parsed.candidates.map((entry) => entry.promptLine).join("\n"),
          },
        ],
        temperature: 0,
        maxOutputTokens: 2000,
      });
      const removeIds = parseRemoveIds(response.content);
      const sourceIndexes = new Set(
        parsed.candidates
          .filter((candidate) => removeIds.has(candidate.id))
          .map((candidate) => candidate.sourceIndex),
      );
      if (sourceIndexes.size === 0) {
        return { data, removed: 0, summary: "AI 判断没有需要删除的广告内容" };
      }
      const cleaned = parsed.remove(sourceIndexes);
      return {
        data: Buffer.from(cleaned, "utf8"),
        removed: sourceIndexes.size,
        summary: `已清理 ${sourceIndexes.size} 条字幕组广告、署名或水印`,
      };
    } catch (error) {
      return {
        data,
        removed: 0,
        summary:
          "AI 广告清理失败，已保留原字幕：" +
          (error instanceof Error ? error.message : String(error)),
      };
    }
  }
}

function parseAss(content: string): ParsedSubtitle {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  let eventFormat: string[] = [];
  let inEvents = false;
  const candidates: CleanCandidate[] = [];

  for (const [sourceIndex, line] of lines.entries()) {
    const trimmed = line.trim();
    if (/^\[Events]/i.test(trimmed)) {
      inEvents = true;
      continue;
    }
    if (/^\[[^\]]+]/.test(trimmed)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^Format:/i.test(trimmed)) {
      eventFormat = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((field) => field.trim());
      continue;
    }
    if (!/^(Dialogue|Comment):/i.test(trimmed)) continue;

    const values = splitLimited(
      line.slice(line.indexOf(":") + 1).trimStart(),
      eventFormat.length || 10,
    );
    const field = (name: string, fallback: number) => {
      const index = eventFormat.findIndex(
        (candidate) => candidate.toLowerCase() === name.toLowerCase(),
      );
      return values[index >= 0 ? index : fallback] ?? "";
    };
    const text = field("Text", 9);
    const plain = text
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\[Nn]/g, " ")
      .trim();
    const id = candidates.length;
    candidates.push({
      id,
      sourceIndex,
      promptLine:
        `[${id}] type="${trimmed.startsWith("Comment:") ? "Comment" : "Dialogue"}" ` +
        `style="${field("Style", 3)}" ` +
        `time="${field("Start", 1)}→${field("End", 2)}" ` +
        `effect="${field("Effect", 8)}" raw="${text}" plain="${plain}"`,
    });
  }

  return {
    candidates,
    remove: (sourceIndexes) =>
      lines.filter((_, index) => !sourceIndexes.has(index)).join(newline),
  };
}

function parseTimedText(content: string, isVtt: boolean): ParsedSubtitle {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const separator = content.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
  const blocks = content.replace(/^\uFEFF/, "").split(/\r?\n\r?\n/);
  const candidates: CleanCandidate[] = [];
  for (const [sourceIndex, block] of blocks.entries()) {
    const lines = block.split(/\r?\n/);
    const timestampIndex = lines.findIndex((line) => line.includes("-->"));
    if (timestampIndex < 0) continue;
    const text = lines.slice(timestampIndex + 1).join(" | ").trim();
    const id = candidates.length;
    candidates.push({
      id,
      sourceIndex,
      promptLine: `[${id}] time="${lines[timestampIndex]?.trim()}" text="${text}"`,
    });
  }

  return {
    candidates,
    remove: (sourceIndexes) => {
      const kept = blocks.filter((_, index) => !sourceIndexes.has(index));
      if (isVtt) return kept.join(separator);
      let sequence = 0;
      return kept
        .map((block) => {
          const lines = block.split(/\r?\n/);
          if (/^\d+$/.test(lines[0]?.trim() ?? "") && lines[1]?.includes("-->")) {
            sequence += 1;
            lines[0] = String(sequence);
          }
          return lines.join(newline);
        })
        .join(separator);
    },
  };
}

function splitLimited(value: string, fields: number): string[] {
  const result: string[] = [];
  let start = 0;
  for (let count = 1; count < fields; count += 1) {
    const index = value.indexOf(",", start);
    if (index < 0) break;
    result.push(value.slice(start, index));
    start = index + 1;
  }
  result.push(value.slice(start));
  return result;
}

function parseRemoveIds(value: string): Set<number> {
  const objectMatch = value.match(/\{[\s\S]*\}/);
  const arrayMatch = value.match(/\[[\s\S]*?\]/);
  try {
    const parsed = JSON.parse(objectMatch?.[0] ?? arrayMatch?.[0] ?? "[]") as
      | { remove?: unknown[] }
      | unknown[];
    const values = Array.isArray(parsed) ? parsed : (parsed.remove ?? []);
    return new Set(
      values.filter(
        (item): item is number =>
          typeof item === "number" && Number.isInteger(item) && item >= 0,
      ),
    );
  } catch {
    return new Set();
  }
}
