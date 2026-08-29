import { createAiClient } from "../ai/client.js";
import type { AiClient } from "../ai/types.js";
import type { ConfigStore } from "../db/config-store.js";
import type { PromptStore } from "../db/prompt-store.js";
import { SubtitleDocument } from "./subtitle-document.js";

export interface CleanResult {
  data: Buffer;
  removed: number;
  summary: string;
}

type AiClientFactory = typeof createAiClient;

export class SubtitleCleaner {
  constructor(
    private readonly configs: ConfigStore,
    private readonly prompts: PromptStore,
    private readonly clientFactory: AiClientFactory = createAiClient,
  ) {}

  async clean(filename: string, data: Buffer): Promise<CleanResult> {
    const document = SubtitleDocument.parse(filename, data.toString("utf8"));
    if (!document) {
      return {
        data,
        removed: 0,
        summary: "SUP 或其他二进制字幕不执行广告清理",
      };
    }
    if (document.events.length === 0) {
      return { data, removed: 0, summary: "字幕中没有可分析的事件" };
    }

    const client = this.aiClient();
    if (!client) {
      return {
        data,
        removed: 0,
        summary: "没有可用 AI 模型，已保留原字幕",
      };
    }

    try {
      const response = await client.value.generate({
        model: client.model,
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
              document.events.map((event) => event.cleanerPromptLine).join("\n"),
          },
        ],
        temperature: 0,
        maxOutputTokens: 2000,
      });
      const removeIds = parseRemoveIds(response.content);
      const knownIds = new Set(document.events.map((event) => event.id));
      const validIds = new Set([...removeIds].filter((id) => knownIds.has(id)));
      if (validIds.size === 0) {
        return { data, removed: 0, summary: "AI 判断没有需要删除的广告内容" };
      }
      return {
        data: Buffer.from(document.removeEvents(validIds), "utf8"),
        removed: validIds.size,
        summary: `已清理 ${validIds.size} 条字幕组广告、署名或水印`,
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

  private aiClient(): { value: AiClient; model: string } | undefined {
    const model = this.configs.defaultModel();
    const provider = model ? this.configs.provider(model.providerId) : undefined;
    if (!model || !provider || !provider.enabled) return undefined;
    return {
      model: model.model,
      value: this.clientFactory(provider.protocol, {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        headers: provider.customHeaders,
      }),
    };
  }
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
