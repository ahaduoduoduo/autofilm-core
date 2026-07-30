import { useEffect, useState } from "react";
import { RadioTower, Trash2 } from "lucide-react";
import type { WatchlistSummary } from "@autofilm/contracts";
import { api } from "../lib/api.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Loading,
  PageHeader,
} from "../components/Ui.js";
import { useToast } from "../components/Toast.js";

interface WatchlistEntry extends WatchlistSummary {
  episodes: Array<{
    episodeNumber: number;
    airDate: string;
    status: "upcoming" | "aired" | "notified" | "downloaded";
  }>;
}

export function WatchlistsPage() {
  const { notify } = useToast();
  const [entries, setEntries] = useState<WatchlistEntry[] | null>(null);

  async function load() {
    setEntries(await api("/api/admin/watchlists"));
  }
  useEffect(() => void load(), []);
  if (!entries) return <Loading />;

  return (
    <div>
      <PageHeader
        eyebrow="AUTOMATION"
        title="追更"
        description="追更按成员隔离；定时读取 TMDB 播出信息并通过只读 Agent 检查资源和字幕，不查询网盘目录。"
      />
      {entries.length ? (
        <div className="card-grid">
          {entries.map((entry) => {
            const pending = entry.episodes.filter(
              (episode) =>
                episode.status === "aired" || episode.status === "upcoming",
            ).length;
            return (
              <Card className="config-card" key={entry.id}>
                <div className="config-card-head">
                  <div className="config-icon">
                    <RadioTower size={19} />
                  </div>
                  <div className="config-title">
                    <strong>{entry.title}</strong>
                    <span>
                      S{String(entry.season).padStart(2, "0")} · TMDB {entry.tmdbId}
                    </span>
                  </div>
                  <Badge tone={entry.status === "active" ? "success" : "neutral"}>
                    {entry.status === "active" ? "追更中" : entry.status}
                  </Badge>
                </div>
                <p className="config-description">
                  {entry.conditions || "有可用发布版本"}
                </p>
                <div className="config-url">{entry.destination}</div>
                <div className="config-meta">
                  <span>
                    共 {entry.totalEpisodes} 集，{pending} 集待处理
                  </span>
                  <span>
                    下次检查：
                    {new Date(entry.nextCheckAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </span>
                </div>
                <div className="config-actions">
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (!window.confirm("删除这个追更项？")) return;
                      await api(`/api/admin/watchlists/${entry.id}`, {
                        method: "DELETE",
                      });
                      await load();
                      notify("追更项已删除");
                    }}
                  >
                    <Trash2 size={15} /> 删除
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<RadioTower size={24} />}
            title="追更列表为空"
            description="成员通过聊天 Agent 添加追更后，管理状态会显示在这里。"
          />
        </Card>
      )}
    </div>
  );
}
