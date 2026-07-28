import { useEffect, useState } from "react";
import type { TaskState, TaskSummary } from "@autofilm/contracts";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Download,
  RefreshCw,
} from "lucide-react";
import { api } from "../lib/api.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Loading,
  PageHeader,
} from "../components/Ui.js";

export function TasksPage() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load(showSpinner = false) {
    if (showSpinner) setRefreshing(true);
    try {
      setTasks(await api("/api/admin/tasks"));
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!tasks) return <Loading />;

  const counts = {
    active: tasks.filter((task) =>
      ["queued", "running", "waiting"].includes(task.state),
    ).length,
    completed: tasks.filter((task) => task.state === "completed").length,
    failed: tasks.filter((task) => task.state === "failed").length,
  };
  return (
    <div>
      <PageHeader
        eyebrow="OPERATIONS"
        title="任务"
        description="离线下载进度从 OpenList 的内存任务管理器读取，不查询 115 文件对象，也不触发网盘刷新。"
        actions={
          <Button
            variant="secondary"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            <RefreshCw size={16} className={refreshing ? "spin" : ""} />
            刷新
          </Button>
        }
      />
      <div className="task-metrics">
        <MiniMetric
          icon={<Activity size={18} />}
          label="进行中"
          value={counts.active}
          tone="accent"
        />
        <MiniMetric
          icon={<CheckCircle2 size={18} />}
          label="已完成"
          value={counts.completed}
          tone="success"
        />
        <MiniMetric
          icon={<CircleAlert size={18} />}
          label="失败"
          value={counts.failed}
          tone="danger"
        />
      </div>
      <Card className="table-card">
        {tasks.length ? (
          <div className="data-table">
            <div className="data-row data-head task-table-row">
              <span>任务</span>
              <span>进度</span>
              <span>状态</span>
              <span>更新时间</span>
            </div>
            {tasks.map((task) => (
              <div className="data-row task-table-row" key={task.id}>
                <span className="task-title-cell">
                  <span className="mini-icon">
                    <Download size={15} />
                  </span>
                  <span>
                    <strong>{task.title}</strong>
                    <small>{task.statusText || task.type}</small>
                  </span>
                </span>
                <span className="progress-cell">
                  <span className="progress-track">
                    <span
                      style={{ width: `${task.progress ?? 0}%` }}
                      className={task.state === "failed" ? "progress-failed" : ""}
                    />
                  </span>
                  <small>{task.progress === null ? "—" : `${task.progress.toFixed(1)}%`}</small>
                </span>
                <Badge tone={taskTone(task.state)}>{taskName(task.state)}</Badge>
                <span className="time-cell">
                  <Clock3 size={14} />
                  {new Date(task.updatedAt).toLocaleString("zh-CN", {
                    hour12: false,
                  })}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Download size={24} />}
            title="还没有任务"
            description="成员通过聊天 Agent 创建离线下载后，任务与进度会出现在这里。"
          />
        )}
      </Card>
    </div>
  );
}

function MiniMetric({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "accent" | "success" | "danger";
}) {
  return (
    <Card className="mini-metric">
      <span className={`mini-metric-icon ${tone}`}>{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </Card>
  );
}

function taskTone(
  state: TaskState,
): "neutral" | "success" | "warning" | "danger" | "accent" {
  if (state === "completed") return "success";
  if (state === "failed" || state === "cancelled") return "danger";
  if (state === "running") return "accent";
  return "warning";
}

function taskName(state: TaskState): string {
  const names: Record<TaskState, string> = {
    queued: "排队",
    running: "运行中",
    waiting: "等待",
    completed: "完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return names[state] ?? state;
}
