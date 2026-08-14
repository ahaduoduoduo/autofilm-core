import { modifyAss, type AssModifyOptions } from "./ass-style.js";
import type { SubtitleCleaner } from "./cleaner.js";
import type { SubtitleMainlandRewriter } from "./mainland-rewriter.js";

export type SubtitleOperation =
  | { type: "remove_ads" }
  | { type: "mainland_wording" }
  | { type: "ass_style"; options: AssModifyOptions };

export interface SubtitleOperationResult {
  type: SubtitleOperation["type"];
  summary: string;
  removedEvents?: number;
  eligibleEvents?: number;
  rewrittenEvents?: number;
  rewrittenSegments?: number;
}

export interface SubtitleProcessingResult {
  data: Buffer;
  operations: SubtitleOperationResult[];
}

export class SubtitleProcessor {
  constructor(
    private readonly cleaner: SubtitleCleaner,
    private readonly mainlandRewriter: SubtitleMainlandRewriter,
  ) {}

  async process(
    filename: string,
    data: Buffer,
    operations: readonly SubtitleOperation[],
  ): Promise<SubtitleProcessingResult> {
    let current = data;
    const results: SubtitleOperationResult[] = [];
    for (const operation of operations) {
      if (operation.type === "remove_ads") {
        const cleaned = await this.cleaner.clean(filename, current);
        current = cleaned.data;
        results.push({
          type: operation.type,
          summary: cleaned.summary,
          removedEvents: cleaned.removed,
        });
        continue;
      }
      if (operation.type === "mainland_wording") {
        const rewritten = await this.mainlandRewriter.rewrite(filename, current);
        current = rewritten.data;
        results.push({
          type: operation.type,
          summary: rewritten.summary,
          eligibleEvents: rewritten.eligibleEvents,
          rewrittenEvents: rewritten.rewrittenEvents,
          rewrittenSegments: rewritten.rewrittenSegments,
        });
        continue;
      }
      const extension = filename.toLowerCase().match(/\.(ass|ssa)$/)?.[1];
      if (!extension) throw new Error("ASS 样式操作只支持 ASS 或 SSA 字幕");
      current = Buffer.from(
        modifyAss(current.toString("utf8"), operation.options),
        "utf8",
      );
      results.push({ type: operation.type, summary: "ASS 样式修改完成" });
    }
    return { data: current, operations: results };
  }
}
