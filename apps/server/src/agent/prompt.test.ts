import { describe, expect, it } from "vitest";
import { promptDefinition } from "./prompt.js";

describe("subtitle mainland rewriter prompt", () => {
  it("emphasizes Hong Kong spoken Cantonese and regional wording", () => {
    const definition = promptDefinition("subtitle.mainland_rewriter");
    const compactContent = definition?.content.replace(/\s+/g, "");
    expect(definition?.version).toBe(2);
    expect(definition?.content).not.toContain("当前请求只包含一个字幕文件");
    expect(definition?.content).toContain("粤语口语直接写入中文字幕");
    expect(definition?.content).toContain("不使用固定词表或一对一替换规则");
    expect(compactContent).toContain("香港常用但不符合大陆习惯");
    expect(definition?.content).toContain("文言文混合白话文");
    expect(definition?.content).toContain("高优先级修改对象");
    expect(definition?.content).toContain("不要保留半文半白的翻译腔");
    expect(definition?.content).toContain("台湾常用但不符合大陆习惯");
    expect(definition?.content).toContain("用词、名词、译名");
  });
});
