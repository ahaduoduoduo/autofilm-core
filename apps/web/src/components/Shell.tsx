import {
  Bot,
  Boxes,
  ChevronRight,
  Film,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareMore,
  Moon,
  Sun,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { SessionUser } from "@autofilm/contracts";
import { Button } from "./Ui.js";

const navigation = [
  { to: "/", label: "总览", icon: LayoutDashboard, end: true },
  { to: "/ai", label: "AI 与模型", icon: Bot },
  { to: "/members", label: "成员", icon: Users },
  { to: "/channels", label: "聊天渠道", icon: MessageSquareMore },
  { to: "/services", label: "媒体服务", icon: Boxes },
  { to: "/tasks", label: "任务", icon: Film },
  { to: "/playground", label: "Agent 测试", icon: FlaskConical },
];

export function Shell({
  user,
  path,
  onNavigate,
  onLogout,
  children,
}: {
  user: SessionUser;
  path: string;
  onNavigate: (path: string) => void;
  onLogout: () => Promise<void>;
  children: ReactNode;
}) {
  const [dark, setDark] = useState(
    () =>
      localStorage.getItem("autofilm-theme") !== "light" &&
      (localStorage.getItem("autofilm-theme") === "dark" ||
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("autofilm-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => setOpen(false), [path]);

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>AutoFilm</strong>
            <span>CORE</span>
          </div>
          <button
            className="mobile-close"
            onClick={() => setOpen(false)}
            aria-label="关闭导航"
          >
            <X size={20} />
          </button>
        </div>
        <div className="sidebar-label">管理</div>
        <nav>
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = item.end
              ? path === item.to
              : path === item.to || path.startsWith(`${item.to}/`);
            return (
              <a
                key={item.to}
                href={item.to}
                className={`nav-item ${active ? "nav-active" : ""}`}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate(item.to);
                }}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                <ChevronRight className="nav-arrow" size={15} />
              </a>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div className="avatar">
            {user.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div className="user-meta">
            <strong>{user.displayName}</strong>
            <span>{roleName(user.role)}</span>
          </div>
          <button className="logout-button" onClick={() => void onLogout()}>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      {open && (
        <button
          className="sidebar-scrim"
          onClick={() => setOpen(false)}
          aria-label="关闭导航"
        />
      )}
      <div className="main-column">
        <header className="topbar">
          <Button
            variant="ghost"
            className="icon-button mobile-menu"
            onClick={() => setOpen(true)}
          >
            <Menu size={20} />
          </Button>
          <div className="topbar-context">
            <span className="status-dot" />
            Core 正常运行
          </div>
          <Button
            variant="secondary"
            className="icon-button"
            onClick={() => setDark((value) => !value)}
            aria-label="切换主题"
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </Button>
        </header>
        <main className="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}

function roleName(role: SessionUser["role"]): string {
  return role === "owner" ? "所有者" : role === "admin" ? "管理员" : "成员";
}
