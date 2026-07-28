import { FormEvent, useState } from "react";
import { Eye, EyeOff, LockKeyhole, Sparkles } from "lucide-react";
import { api, jsonBody } from "../lib/api.js";
import { Button, Field, Input } from "../components/Ui.js";
import { useToast } from "../components/Toast.js";

export function AuthPage({
  setup,
  onAuthenticated,
}: {
  setup: boolean;
  onAuthenticated: () => Promise<void>;
}) {
  const { notify } = useToast();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(
        setup ? "/api/setup" : "/api/auth/login",
        jsonBody(
          setup
            ? { username, displayName: displayName || username, password }
            : { username, password },
        ),
      );
      notify(setup ? "所有者账号已创建" : "登录成功");
      await onAuthenticated();
    } catch (error) {
      notify(error instanceof Error ? error.message : "操作失败", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-orb auth-orb-one" />
      <div className="auth-orb auth-orb-two" />
      <section className="auth-intro">
        <div className="brand-lockup">
          <div className="brand-mark large">A</div>
          <div>
            <strong>AutoFilm</strong>
            <span>CORE</span>
          </div>
        </div>
        <div className="auth-copy">
          <div className="eyebrow">
            <Sparkles size={14} /> YOUR MEDIA, ON REQUEST
          </div>
          <h1>把想看的内容，交给一个真正懂媒体库的 Agent。</h1>
          <p>
            一处管理 AI、成员、聊天渠道、OpenList、Jellyfin 与下载任务。
            聊天工具负责消息，Core 负责业务。
          </p>
        </div>
        <div className="auth-stat-row">
          <div>
            <strong>4</strong>
            <span>AI 协议</span>
          </div>
          <div>
            <strong>∞</strong>
            <span>供应方</span>
          </div>
          <div>
            <strong>1</strong>
            <span>统一入口</span>
          </div>
        </div>
      </section>
      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-icon">
            <LockKeyhole size={22} />
          </div>
          <h2>{setup ? "初始化 AutoFilm" : "欢迎回来"}</h2>
          <p>
            {setup
              ? "创建首个所有者账号。系统不会生成默认密码。"
              : "登录管理你的观影自动化服务。"}
          </p>
          <div className="form-stack">
            <Field label="用户名">
              <Input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="admin"
                required
                minLength={3}
              />
            </Field>
            {setup && (
              <Field label="显示名称">
                <Input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="媒体库管理员"
                  required
                />
              </Field>
            )}
            <Field
              label="密码"
              hint={setup ? "至少 12 个字符，不会以明文保存" : undefined}
            >
              <div className="password-field">
                <Input
                  type={showPassword ? "text" : "password"}
                  autoComplete={setup ? "new-password" : "current-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={setup ? 12 : 1}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </Field>
          </div>
          <Button className="auth-submit" disabled={busy}>
            {busy ? "正在处理…" : setup ? "创建并进入" : "登录"}
          </Button>
          <div className="auth-footnote">
            凭据由 Core 本地保存；AI 供应方不限定为任何具体平台。
          </div>
        </form>
      </section>
    </div>
  );
}
