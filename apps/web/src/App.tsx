import { useCallback, useEffect, useState } from "react";
import type { SessionUser } from "@autofilm/contracts";
import { api } from "./lib/api.js";
import { Loading } from "./components/Ui.js";
import { ToastProvider } from "./components/Toast.js";
import { AuthPage } from "./pages/AuthPage.js";
import { Shell } from "./components/Shell.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { AiPage } from "./pages/AiPage.js";
import { MembersPage } from "./pages/MembersPage.js";
import { ChannelsPage } from "./pages/ChannelsPage.js";
import { ServicesPage } from "./pages/ServicesPage.js";
import { TasksPage } from "./pages/TasksPage.js";
import { PlaygroundPage } from "./pages/PlaygroundPage.js";
import { WatchlistsPage } from "./pages/WatchlistsPage.js";
import { PromptsPage } from "./pages/PromptsPage.js";
import { Button, Card } from "./components/Ui.js";
import { MessageSquareMore } from "lucide-react";

interface SessionResponse {
  authenticated: true;
  user: SessionUser;
}

export function App() {
  const [loading, setLoading] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [path, setPath] = useState(window.location.pathname);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const setup = await api<{ required: boolean }>("/api/setup/status");
      setSetupRequired(setup.required);
      if (!setup.required) {
        try {
          const session = await api<SessionResponse>("/api/auth/session");
          setUser(session.user);
        } catch {
          setUser(null);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  if (loading) {
    return (
      <div className="app-loading">
        <Loading />
      </div>
    );
  }

  if (setupRequired || !user) {
    return (
      <ToastProvider>
        <AuthPage setup={setupRequired} onAuthenticated={refresh} />
      </ToastProvider>
    );
  }

  if (user.role === "member") {
    return (
      <ToastProvider>
        <div className="member-access-page">
          <Card className="member-access-card">
            <MessageSquareMore size={28} />
            <h1>{user.displayName}</h1>
            <p>
              此账号是普通成员，不具备管理页面权限。观影请求和任务通知通过已绑定的聊天
              Adapter 处理。
            </p>
            <Button
              variant="secondary"
              onClick={async () => {
                await api("/api/auth/logout", { method: "POST" });
                setUser(null);
              }}
            >
              退出登录
            </Button>
          </Card>
        </div>
      </ToastProvider>
    );
  }

  const navigate = (next: string) => {
    if (next === path) return;
    window.history.pushState({}, "", next);
    setPath(next);
  };
  return (
    <ToastProvider>
      <Shell
        user={user}
        path={path}
        onNavigate={navigate}
        onLogout={async () => {
          await api("/api/auth/logout", { method: "POST" });
          setUser(null);
        }}
      >
        {pageFor(path, user)}
      </Shell>
    </ToastProvider>
  );
}

function pageFor(path: string, user: SessionUser) {
  switch (path.replace(/\/+$/, "") || "/") {
    case "/":
      return <DashboardPage />;
    case "/ai":
      return <AiPage />;
    case "/members":
      return <MembersPage user={user} />;
    case "/prompts":
      return <PromptsPage />;
    case "/channels":
      return <ChannelsPage />;
    case "/services":
      return <ServicesPage />;
    case "/tasks":
      return <TasksPage />;
    case "/watchlists":
      return <WatchlistsPage />;
    case "/playground":
      return <PlaygroundPage />;
    default:
      return <DashboardPage />;
  }
}
