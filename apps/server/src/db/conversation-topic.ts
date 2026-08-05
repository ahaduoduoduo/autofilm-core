export interface TopicMemoryEntry {
  mediaType: "movie" | "tv";
  tmdbId: number;
  title: string;
  productionYear?: number;
  summary: string;
}

export function formatTopicMemory(summaries: TopicMemoryEntry[]): string {
  if (summaries.length === 0) return "";
  const blocks: string[] = [];
  let length = 0;
  for (const item of summaries) {
    const block =
      `### ${item.title}${item.productionYear ? ` (${item.productionYear})` : ""}\n` +
      `身份：${item.mediaType} / TMDB ${item.tmdbId}\n${item.summary.trim()}`;
    if (length + block.length > 16_000) break;
    blocks.push(block);
    length += block.length;
  }
  return `## 较早影视主题摘要\n\n${blocks.join("\n\n")}`;
}
