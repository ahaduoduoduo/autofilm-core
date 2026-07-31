import type { AgentTool, ToolDependencies } from "./tool-types.js";
import { createBaseTools } from "./toolsets/base.js";
import { createJellyfinTools } from "./toolsets/jellyfin.js";
import { createOpenListTools } from "./toolsets/openlist.js";
import { createSubtitleTools } from "./toolsets/subtitles.js";
import { createWatchlistTools } from "./toolsets/watchlists.js";
import { createMediaUpgradeTools } from "./toolsets/media-upgrades.js";
import { createMediaUpgradeCheckTools } from "./toolsets/media-upgrade-checks.js";
import { createUserMemoryTools } from "./toolsets/user-memories.js";

export type { AgentTool, ToolDependencies } from "./tool-types.js";

export function createAgentTools(deps: ToolDependencies): AgentTool[] {
  return [
    ...createBaseTools(deps),
    ...createOpenListTools(deps),
    ...createSubtitleTools(deps),
    ...createJellyfinTools(deps),
    ...createMediaUpgradeTools(deps),
    ...createMediaUpgradeCheckTools(deps),
    ...createWatchlistTools(deps),
    ...createUserMemoryTools(deps),
  ];
}
