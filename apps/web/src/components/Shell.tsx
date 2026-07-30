import { Film, LogOut } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { SessionUser } from "@autofilm/contracts";
import { Button } from "./Ui.js";

const navigation = [
  { to: "/", label: "总览", end: true },
  { to: "/ai", label: "AI 与模型" },
  { to: "/prompts", label: "提示词" },
  { to: "/members", label: "成员" },
  { to: "/channels", label: "聊天渠道" },
  { to: "/services", label: "媒体服务" },
  { to: "/tasks", label: "任务" },
  { to: "/watchlists", label: "追更" },
  { to: "/playground", label: "Agent 测试" },
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
  const activeIndex = navigation.findIndex((item) =>
    item.end
      ? path === item.to
      : path === item.to || path.startsWith(`${item.to}/`),
  );
  const resolvedIndex = activeIndex < 0 ? 0 : activeIndex;
  const previousIndex = useRef(resolvedIndex);
  const direction = resolvedIndex >= previousIndex.current ? 1 : -1;

  useEffect(() => {
    previousIndex.current = resolvedIndex;
  }, [resolvedIndex]);

  return (
    <div className="shell">
      <header className="app-header">
        <div className="page-container header-content">
          <Film className="app-logo" size={32} strokeWidth={2} />
          <div className="header-actions">
            <span className="current-user">
              {user.displayName} · {roleName(user.role)}
            </span>
            <Button variant="secondary" onClick={() => void onLogout()}>
              <LogOut size={15} />
              登出
            </Button>
          </div>
        </div>
      </header>
      <div className="main-column">
        <main className="page-container main-content">
          <nav className="top-tabs" aria-label="管理页面">
            <div className="top-tabs-track">
              <motion.div
                className="top-tab-indicator"
                style={{ width: `${100 / navigation.length}%` }}
                animate={{ x: `${resolvedIndex * 100}%` }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              />
              {navigation.map((item) => {
                const active = item.end
                  ? path === item.to
                  : path === item.to || path.startsWith(`${item.to}/`);
                return (
                  <a
                    key={item.to}
                    href={item.to}
                    className={`top-tab ${active ? "top-tab-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      onNavigate(item.to);
                    }}
                  >
                    {item.label}
                  </a>
                );
              })}
            </div>
          </nav>
          <div className="page-stage">
            <AnimatePresence initial={false} custom={direction} mode="popLayout">
              <motion.div
                key={path}
                className="page-content"
                custom={direction}
                variants={pageVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}

const pageVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? "100%" : "-100%",
    opacity: 0,
  }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({
    x: direction < 0 ? "100%" : "-100%",
    opacity: 0,
  }),
};

function roleName(role: SessionUser["role"]): string {
  return role === "owner" ? "所有者" : role === "admin" ? "管理员" : "成员";
}
