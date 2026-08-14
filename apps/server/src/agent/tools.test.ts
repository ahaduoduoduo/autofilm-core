import { describe, expect, it } from "vitest";
import { createAgentTools } from "./tools.js";
import type { ToolDependencies } from "./tool-types.js";

function dependencies(admin = false): ToolDependencies {
  const placeholder = {} as never;
  return {
    userId: "user-1",
    tasks: placeholder,
    mediaUpgrades: placeholder,
    mediaUpgradeChecks: placeholder,
    userMemories: placeholder,
    tmdb: placeholder,
    jackett: placeholder,
    openList: placeholder,
    jellyfin: placeholder,
    subhd: placeholder,
    subtitleDownloads: placeholder,
    subtitleCleaner: placeholder,
    subtitleWorkspaces: placeholder,
    watchlists: placeholder,
    outbox: placeholder,
    media: placeholder,
    mediaBaseUrl: "http://autofilm-core:3100",
    storageAuth: admin ? { start: async () => ({}) } : undefined,
  };
}

describe("agent tool registry", () => {
  it("registers all migrated member tools with unique names", () => {
    const names = createAgentTools(dependencies()).map(
      (tool) => tool.definition.name,
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(
      [
        "add_watchlist",
        "add_user_memory",
        "adjust_subtitle_style",
        "analyze_subtitle_style",
        "browse_remote_images",
        "browse_trending",
        "create_subtitle_workspace",
        "delete_jellyfin_items",
        "delete_jellyfin_subtitles",
        "delete_user_memory",
        "fetch_subtitle_archive",
        "find_duplicate_jellyfin_movies",
        "get_current_time",
        "get_jellyfin_boxset_details",
        "get_jellyfin_media_info",
        "get_media_upgrade_job",
        "get_bulk_media_upgrade_check_results",
        "get_subtitle_detail",
        "get_subtitle_workspace",
        "get_tmdb_metadata",
        "list_download_tasks",
        "list_jellyfin_episodes",
        "list_jellyfin_subtitle_targets",
        "list_jellyfin_upgrade_check_targets",
        "list_user_memories",
        "list_watchlist",
        "place_subtitles",
        "prepare_subtitle_placements",
        "query_jellyfin_movies",
        "refresh_jellyfin_item",
        "refresh_jellyfin_remote_path",
        "remove_watchlist",
        "resume_offline_download",
        "rollback_media_upgrades",
        "search_catalog",
        "search_jellyfin",
        "search_media_upgrade_candidates",
        "search_releases",
        "search_subtitle",
        "set_jellyfin_image",
        "start_batch_download",
        "start_bulk_media_upgrade_check",
        "start_media_upgrades",
        "start_offline_download",
        "submit_captcha_answer",
        "update_user_memory",
        "view_jellyfin_images",
      ].sort(),
    );
  });

  it("exposes storage authentication only in administrator contexts", () => {
    expect(
      createAgentTools(dependencies()).some(
        (tool) => tool.definition.name === "start_openlist_storage_auth",
      ),
    ).toBe(false);
    expect(
      createAgentTools(dependencies(true)).some(
        (tool) => tool.definition.name === "start_openlist_storage_auth",
      ),
    ).toBe(true);
  });
});
