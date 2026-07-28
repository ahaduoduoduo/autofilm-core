import { useEffect, useState } from "react";
import type { TaskSummary } from "@autofilm/contracts";
import {
  Activity,
  Bot,
  Boxes,
  CircleAlert,
  Clock3,
  MessageSquareMore,
  Users,
} from "lucide-react";
import { api } from "../lib/api.js";
import { Badge, Card, Loading, PageHeader } from "../components/Ui.js";

interface Dashboard {
  members: number;
  pendingIdentities: number;
  activeTasks: number;
  failedTasks: number;
  providers: number;
  services: number;
}

export function DashboardPage() {
  const [summary, setSummary] = useState<Dashboard | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);

  useEffect(() => {
    void Promise.all([
      api<Dashboard>("/api/admin/dashboard"),
      api<TaskSummary[]>("/api/admin/tasks"),
    ]).then(([dashboard, taskList]) => {
      setSummary(dashboard);
      setTasks(taskList.slice(0, 6));
    });
  }, []);

  if (!summary) return <Loading />;
  const cards = [
    {
      label: "活跃任务",
      value: summary.activeTasks,
      detail: summary.failedTasks ? `${summary.failedTasks} 个任务失败` : "运行状态正常",
      icon: Activity,
      tone: "purple",
    },
    {
      label: "已授权成员",
      value: summary.members,
      detail: summary.pendingIdentities
        ? `${summary.pendingIdentities} 个身份待处理`
        : "没有待处理身份",
      icon: Users,
      tone: "cyan",
    },
    {
      label: "AI 供应方",
      value: summary.providers,
      detail: "协议与供应方独立配置",
      icon: Bot,
      tone: "rose",
    },
    {
      label: "媒体服务",
      value: summary.services,
      detail: "OpenList · Jellyfin · 搜索",
      icon: Boxes,
      tone: "amber",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="OVERVIEW"
        title="控制中心"
        description="AutoFilm 的成员请求、Agent 配置和媒体任务集中在这里。"
        actions={
          <div className="live-pill">
            <span /> 系统在线
          </div>
        }
      />
      <div className="metric-grid">
        {cards.map((item) => {
          const Icon = item.icon;
          return (
            <Card className="metric-card" key={item.label}>
              <div className={`metric-icon metric-${item.tone}`}>
                <Icon size={20} />
              </div>
              <div className="metric-label">{item.label}</div>
              <div className="metric-value">{item.value}</div>
              <div className="metric-detail">{item.detail}</div>
            </Card>
          );
        })}
      </div>
      <div className="dashboard-grid">
        <Card className="panel">
          <div className="panel-head">
            <div>
              <h2>最近任务</h2>
              <p>下载和媒体操作的最新状态</p>
            </div>
            <Clock3 size={18} />
          </div>
          {tasks.length ? (
            <div className="task-list">
              {tasks.map((task) => (
                <div className="task-row" key={task.id}>
                  <div className="task-symbol">
                    {task.state === "failed" ? (
                      <CircleAlert size={17} />
                    ) : (
                      <Activity size={17} />
                    )}
                  </div>
                  <div className="task-main">
                    <strong>{task.title}</strong>
                    <span>{task.statusText || task.type}</span>
                  </div>
                  <Badge tone={taskTone(task.state)}>{taskName(task.state)}</Badge>
                </div>
              ))}
            </div>
          ) : (
            <div className="compact-empty">还没有任务记录</div>
          )}
        </Card>
        <Card className="panel architecture-panel">
          <div className="panel-head">
            <div>
              <h2>服务边界</h2>
              <p>渠道与业务保持独立</p>
            </div>
            <MessageSquareMore size={18} />
          </div>
          <div className="architecture-flow">
            <FlowNode label="微信 / Telegram" caption="消息 Adapter" />
            <div className="flow-line">
              <span />
            </div>
            <FlowNode label="AutoFilm Core" caption="Agent · 成员 · 任务" active />
            <div className="flow-line">
              <span />
            </div>
            <FlowNode label="媒体服务" caption="OpenList · Jellyfin" />
          </div>
          <p className="architecture-note">
            New API、官方 API 或其他兼容供应方都通过所选协议进入 Core，
            不影响聊天渠道和媒体服务。
          </p>
        </Card>
      </div>
    </div>
  );
}

function FlowNode({
  label,
  caption,
  active,
}: {
  label: string;
  caption: string;
  active?: boolean;
}) {
  return (
    <div className={`flow-node ${active ? "flow-node-active" : ""}`}>
      <strong>{label}</strong>
      <span>{caption}</span>
    </div>
  );
}

function taskTone(
  state: TaskSummary["state"],
): "neutral" | "success" | "warning" | "danger" | "accent" {
  if (state === "completed") return "success";
  if (state === "failed" || state === "cancelled") return "danger";
  if (state === "running") return "accent";
  return "warning";
}

function taskName(state: TaskSummary["state"]): string {
  const names: Record<TaskSummary["state"], string> = {
    queued: "排队",
    running: "运行中",
    waiting: "等待",
    completed: "完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return names[state] ?? state;
}
