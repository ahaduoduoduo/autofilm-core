import { describe, expect, it } from "vitest";
import { promptDefinition } from "./prompt.js";

describe("main agent subtitle batching rules", () => {
  it("requires one workspace and one placement batch per request", () => {
    const prompt = promptDefinition("agent.main");

    expect(prompt?.version).toBe(22);
    expect(prompt?.content).toContain("必须共用一个 workspace");
    expect(prompt?.content).toContain("一次提交完整映射列表");
    expect(prompt?.content).toContain("不要重复创建");
    expect(prompt?.content).toContain("离线下载提交成功");
    expect(prompt?.content).toContain("不得再说“正在提交”");
    expect(prompt?.content).toContain("这不等于什么");
    expect(prompt?.content).toContain("不得再说“等待升级入库”");
  });

  it("requires exact version confirmation before deleting media", () => {
    const prompt = promptDefinition("agent.main");

    expect(prompt?.content).toContain("MediaSource.Id");
    expect(prompt?.content).toContain("只接受 Movie 和 Episode ID");
    expect(prompt?.content).toContain("不得传 Series、Season");
  });

  it("requires time, TMDB details, inventory, and topic memory tools", () => {
    const prompt = promptDefinition("agent.main");

    expect(prompt?.content).toContain("回答前必须使用");
    expect(prompt?.content).toContain("get_tmdb_metadata");
    expect(prompt?.content).toContain("query_jellyfin_movies");
    expect(prompt?.content).toContain("find_duplicate_jellyfin_movies");
    expect(prompt?.content).toContain("get_jellyfin_boxset_details");
    expect(prompt?.content).toContain("set_active_media_topic");
    expect(promptDefinition("conversation.summarizer")?.content).toContain(
      "已知信息、已完成、待处理",
    );
    expect(promptDefinition("conversation.compactor")?.content).toContain(
      "稳定 ID",
    );
  });

  it("keeps media upgrades on the existing Jellyfin item", () => {
    const prompt = promptDefinition("agent.main");

    expect(prompt?.content).toContain("search_media_upgrade_candidates");
    expect(prompt?.content).toContain("start_media_upgrades");
    expect(prompt?.content).toContain("rollback_media_upgrades");
    expect(prompt?.content).toContain("原 Jellyfin Item ID");
    expect(prompt?.content).toContain("旧文件进入独立备份目录");
    expect(prompt?.content).toContain("upgrade_selection_id");
    expect(prompt?.content).toContain("fallback_upgrade_selection_ids");
    expect(prompt?.content).toContain("start_bulk_media_upgrade_check");
    expect(prompt?.content).toContain("get_bulk_media_upgrade_check_results");
    expect(prompt?.content).toContain("list_jellyfin_upgrade_check_targets");
  });

  it("stores only explicit per-user long-term memories", () => {
    const prompt = promptDefinition("agent.main");

    expect(prompt?.content).toContain("add_user_memory");
    expect(prompt?.content).toContain("update_user_memory");
    expect(prompt?.content).toContain("delete_user_memory");
    expect(prompt?.content).toContain("/new 和 /clear");
  });

  it("uses opaque Jackett candidates and server-resolved magnets", () => {
    const prompt = promptDefinition("agent.main");

    expect(prompt?.content).toContain("release_candidate_id");
    expect(prompt?.content).toContain("fallback_candidate_ids");
    expect(prompt?.content).toContain("torrent");
    expect(prompt?.content).not.toContain("downloadUrl 原样");
  });
});
