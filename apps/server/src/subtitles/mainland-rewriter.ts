import { createAiClient } from "../ai/client.js";
import { estimateGenerateRequestTokens } from "../ai/token-budget.js";
import type { AiClient } from "../ai/types.js";
import type { ConfigStore } from "../db/config-store.js";
import type { PromptStore } from "../db/prompt-store.js";
import { SubtitleDocument } from "./subtitle-document.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export interface MainlandRewriteResult {
  data: Buffer;
  eligibleEvents: number;
  rewrittenEvents: number;
  rewrittenSegments: number;
  summary: string;
}

interface RewriteResponse {
  changes: Array<{
    id: number;
    chinese_segments: Array<{
      index: number;
      text: string;
    }>;
  }>;
}

type AiClientFactory = typeof createAiClient;

export class SubtitleMainlandRewriter {
  constructor(
    private readonly configs: ConfigStore,
    private readonly prompts: PromptStore,
    private readonly clientFactory: AiClientFactory = createAiClient,
  ) {}

  async rewrite(filename: string, data: Buffer): Promise<MainlandRewriteResult> {
    const document = SubtitleDocument.parse(filename, data.toString("utf8"));
    if (!document) throw new Error("大陆用词转换只支持 ASS、SSA、SRT 和 VTT");
    const eligibleEvents = document.events.filter(
      (event) => event.chineseSegments.length > 0,
    ).length;
    if (eligibleEvents === 0) {
      return {
        data,
        eligibleEvents: 0,
        rewrittenEvents: 0,
        rewrittenSegments: 0,
        summary: "字幕中没有可安全修改的中文对白",
      };
    }

    const model = this.configs.defaultModel();
    const provider = model ? this.configs.provider(model.providerId) : undefined;
    if (!model || !provider || !provider.enabled) {
      throw new Error("没有可用 AI 模型，未生成 chs 字幕");
    }
    const client: AiClient = this.clientFactory(provider.protocol, {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      headers: provider.customHeaders,
    });
    const messages = [
      {
        role: "system" as const,
        content: this.prompts.get("subtitle.mainland_rewriter"),
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          file: filename,
          events: document.events.map((event) => ({
            id: event.id,
            type: event.kind,
            text: event.plainText,
            chinese_segments: event.chineseSegments,
          })),
        }),
      },
    ];
    const maxOutputTokens = model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const inputTokens = estimateGenerateRequestTokens(messages);
    if (inputTokens + maxOutputTokens > model.contextWindowTokens) {
      throw new Error(
        `字幕完整上下文估算 ${inputTokens} tokens，预留输出 ${maxOutputTokens} tokens，` +
          `超过当前模型 ${model.contextWindowTokens} tokens 的上下文限制`,
      );
    }

    const response = await client.generate({
      model: model.model,
      messages,
      temperature: 0,
      maxOutputTokens,
    });
    if (isTruncated(response.rawStopReason)) {
      throw new Error("AI 字幕转换输出达到模型长度限制，未生成 chs 字幕");
    }
    const parsed = parseRewriteResponse(response.content);
    const changes = validateChanges(document, parsed);
    const rewrittenEvents = changes.size;
    const rewrittenSegments = [...changes.values()].reduce(
      (total, segments) => total + segments.size,
      0,
    );
    if (rewrittenSegments === 0) {
      return {
        data,
        eligibleEvents,
        rewrittenEvents: 0,
        rewrittenSegments: 0,
        summary: "AI 判断没有明显不符合中国大陆语言习惯的句子",
      };
    }
    return {
      data: Buffer.from(document.replaceChineseSegments(changes), "utf8"),
      eligibleEvents,
      rewrittenEvents,
      rewrittenSegments,
      summary: `已转换 ${rewrittenEvents} 条字幕中的 ${rewrittenSegments} 个中文片段`,
    };
  }
}

function parseRewriteResponse(value: string): RewriteResponse {
  const normalized = value.trim();
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) {
    throw new Error("AI 字幕转换没有返回严格 JSON 对象");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error("AI 字幕转换返回了无效 JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.changes)) {
    throw new Error("AI 字幕转换结果缺少 changes 数组");
  }
  return parsed as unknown as RewriteResponse;
}

function validateChanges(
  document: SubtitleDocument,
  response: RewriteResponse,
): Map<number, Map<number, string>> {
  const events = new Map(document.events.map((event) => [event.id, event]));
  const result = new Map<number, Map<number, string>>();
  for (const rawChange of response.changes) {
    if (!isRecord(rawChange) || !Number.isInteger(rawChange.id)) {
      throw new Error("AI 字幕转换包含无效事件 ID");
    }
    const event = events.get(rawChange.id as number);
    if (!event) throw new Error(`AI 字幕转换返回了未知事件 ID ${rawChange.id}`);
    if (result.has(event.id)) {
      throw new Error(`AI 字幕转换重复返回事件 ID ${event.id}`);
    }
    if (!Array.isArray(rawChange.chinese_segments)) {
      throw new Error(`AI 字幕转换事件 ${event.id} 缺少 chinese_segments`);
    }
    const knownSegments = new Map(
      event.chineseSegments.map((segment) => [segment.index, segment]),
    );
    const segments = new Map<number, string>();
    for (const rawSegment of rawChange.chinese_segments) {
      if (
        !isRecord(rawSegment) ||
        !Number.isInteger(rawSegment.index) ||
        typeof rawSegment.text !== "string"
      ) {
        throw new Error(`AI 字幕转换事件 ${event.id} 包含无效中文片段`);
      }
      const segment = knownSegments.get(rawSegment.index as number);
      if (!segment) {
        throw new Error(
          `AI 字幕转换事件 ${event.id} 返回了未知中文片段 ${rawSegment.index}`,
        );
      }
      if (segments.has(segment.index)) {
        throw new Error(
          `AI 字幕转换事件 ${event.id} 重复返回中文片段 ${segment.index}`,
        );
      }
      const replacement = rawSegment.text as string;
      if (!replacement || !/^\p{Script=Han}+$/u.test(replacement)) {
        throw new Error(
          `AI 字幕转换事件 ${event.id} 的片段 ${segment.index} 修改了非中文内容`,
        );
      }
      if (replacement !== segment.text) segments.set(segment.index, replacement);
    }
    if (segments.size > 0) result.set(event.id, segments);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTruncated(reason: string | undefined): boolean {
  return Boolean(reason && /length|max[_ -]?tokens|output[_ -]?limit/i.test(reason));
}
