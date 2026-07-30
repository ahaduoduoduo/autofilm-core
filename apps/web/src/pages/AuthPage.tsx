import { FormEvent, useState } from "react";
import { api, jsonBody } from "../lib/api.js";
import { Button, Card, Field, Input } from "../components/Ui.js";
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
      <Card className={`auth-card ${setup ? "auth-card-setup" : ""}`}>
        <div className="auth-card-header">
          <h1>{setup ? "初始化" : "登录"}</h1>
          <p>
            {setup
              ? "创建 AutoFilm Core 的首个所有者账号"
              : "请输入您的用户名和密码登录"}
          </p>
        </div>
        <form onSubmit={submit}>
          <div className="auth-card-content">
            <div className="form-stack">
              <Field label="用户名">
                <Input
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="请输入用户名"
                  required
                  minLength={3}
                />
              </Field>
              {setup && (
                <Field label="显示名称">
                  <Input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="请输入显示名称"
                    required
                  />
                </Field>
              )}
              <Field label="密码" hint={setup ? "至少 12 个字符" : undefined}>
                <Input
                  type="password"
                  autoComplete={setup ? "new-password" : "current-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="请输入密码"
                  required
                  minLength={setup ? 12 : 1}
                />
              </Field>
            </div>
          </div>
          <div className="auth-card-footer">
            <Button className="auth-submit" disabled={busy}>
              {busy ? "正在处理…" : setup ? "创建并进入" : "登录"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
