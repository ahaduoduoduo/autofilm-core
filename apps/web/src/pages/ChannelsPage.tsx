import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ChannelConfigSummary } from "@autofilm/contracts";
import {
  Braces,
  CheckCircle2,
  CirclePlus,
  Copy,
  KeyRound,
  MessageSquareMore,
  Pencil,
  Radio,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api, jsonBody } from "../lib/api.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Toggle,
} from "../components/Ui.js";
import { useToast } from "../components/Toast.js";

interface WeClawStatus {
  available: boolean;
  configReady: boolean;
  accounts: Array<{
    providerInstanceId: string;
    configured: boolean;
    enabled: boolean;
  }>;
}

export function ChannelsPage() {
  const { notify } = useToast();
  const [channels, setChannels] = useState<ChannelConfigSummary[] | null>(null);
  const [editing, setEditing] =
    useState<Partial<ChannelConfigSummary> | null>(null);

  async function load() {
    setChannels(await api("/api/admin/channels"));
  }
  useEffect(() => void load(), []);
  if (!channels) return <Loading />;

  return (
    <div>
      <PageHeader
        eyebrow="ADAPTERS"
        title="聊天渠道"
        description="Adapter 负责登录和消息格式，Core 依据统一 Native Message Service 协议处理成员与业务。"
        actions={
          <Button onClick={() => setEditing({ type: "native", enabled: true })}>
            <CirclePlus size={17} /> 添加 Adapter
          </Button>
        }
      />
      <Card className="boundary-card">
        <div className="boundary-icon">
          <Radio size={21} />
        </div>
        <div>
          <strong>渠道实现不属于 AutoFilm Core</strong>
          <p>
            WeClaw 是微信 Adapter；Telegram Adapter 已作为独立容器提供。
            其他聊天工具也可实现相同协议，业务规则、成员权限和会话仍由 Core 保存。
          </p>
        </div>
        <Badge tone="accent">Native 2026-07-01</Badge>
      </Card>
      {channels.length ? (
        <div className="card-grid">
          {channels.map((channel) => (
            <Card className="config-card" key={channel.id}>
              <div className="config-card-head">
                <div className="config-icon">
                  <MessageSquareMore size={19} />
                </div>
                <div className="config-title">
                  <strong>{channel.name}</strong>
                  <span>{channel.providerInstanceId}</span>
                </div>
                <Badge tone={channel.enabled ? "success" : "neutral"}>
                  {channel.enabled ? "启用" : "停用"}
                </Badge>
              </div>
              <div className="config-url">
                {channel.baseUrl || "未配置主动消息地址"}
              </div>
              <div className="config-meta">
                <span>
                  <KeyRound size={14} />
                  入站 {channel.hasInboundToken ? "已认证" : "未认证"}
                </span>
                <span>
                  <Radio size={14} />
                  出站 {channel.hasOutboundToken ? "已认证" : "未认证"}
                </span>
              </div>
              <div className="config-actions">
                <Button
                  variant="secondary"
                  onClick={() => setEditing(channel)}
                >
                  <Pencil size={15} /> 编辑
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void remove(channel.id)}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<MessageSquareMore size={24} />}
            title="还没有聊天 Adapter"
            description="添加 WeClaw 或其他实现 Native Message Service 协议的 Adapter。"
            action={
              <Button onClick={() => setEditing({ type: "native", enabled: true })}>
                添加第一个 Adapter
              </Button>
            }
          />
        </Card>
      )}
      {editing && (
        <ChannelModal
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );

  async function remove(id: string) {
    if (!window.confirm("删除这个 Adapter 配置？")) return;
    await api(`/api/admin/channels/${id}`, { method: "DELETE" });
    await load();
    notify("Adapter 已删除");
  }
}

function ChannelModal({
  value,
  onClose,
  onSaved,
}: {
  value: Partial<ChannelConfigSummary>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { notify } = useToast();
  const [preset, setPreset] = useState<"weclaw" | "telegram" | "generic">(
    value.baseUrl?.includes("telegram-adapter")
      ? "telegram"
      : value.baseUrl?.includes("weclaw")
        ? "weclaw"
        : value.id
          ? "generic"
          : "weclaw",
  );
  const [name, setName] = useState(value.name ?? "WeClaw");
  const [providerInstanceId, setProviderInstanceId] = useState(
    value.providerInstanceId ?? "",
  );
  const [baseUrl, setBaseUrl] = useState(value.baseUrl ?? "");
  const [inboundToken, setInboundToken] = useState("");
  const [outboundToken, setOutboundToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [enabled, setEnabled] = useState(value.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [weClawStatus, setWeClawStatus] = useState<WeClawStatus | null>(null);

  const sample = useMemo(() => {
    return [
      "Core endpoint: http://autofilm-core:3100/v1/conversation/events",
      `Adapter endpoint: ${baseUrl || "<adapter-base-url>"}/v1/messages`,
      `provider_instance_id: ${providerInstanceId || "<instance-id>"}`,
      `Adapter → Core token: ${inboundToken || "<inbound-token>"}`,
      `Core → Adapter token: ${outboundToken || "<outbound-token>"}`,
    ].join("\n");
  }, [baseUrl, inboundToken, outboundToken, providerInstanceId]);

  useEffect(() => {
    if (preset !== "weclaw") return;
    void loadWeClawStatus();
  }, [preset]);

  async function loadWeClawStatus() {
    try {
      setWeClawStatus(
        await api<WeClawStatus>("/api/admin/channels/weclaw/status"),
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "读取微信状态失败", "error");
    }
  }

  function applyPreset(next: "weclaw" | "telegram" | "generic") {
    setPreset(next);
    if (next === "telegram") {
      setName("Telegram");
      setProviderInstanceId("telegram-main");
      setBaseUrl("http://telegram-adapter:18012");
    } else if (next === "weclaw") {
      setName("WeClaw");
    }
  }

  async function generateTokens() {
    const first = await api<{ token: string }>("/api/admin/channels/token", {
      method: "POST",
    });
    const second = await api<{ token: string }>("/api/admin/channels/token", {
      method: "POST",
    });
    setInboundToken(first.token);
    setOutboundToken(second.token);
    notify("已生成两组不同的随机令牌");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (preset === "weclaw") {
        const result = await api<WeClawStatus>(
          "/api/admin/channels/weclaw/reconcile",
          jsonBody({ enabled }),
        );
        if (!result.available || !result.configReady) {
          throw new Error("AutoFilm 尚未检测到 WeClaw 运行配置");
        }
        if (!result.accounts.length) {
          throw new Error("尚未检测到已登录的微信账号");
        }
        await onSaved();
        notify(`已识别 ${result.accounts.length} 个微信账号`);
        return;
      }
      if (preset === "telegram" && botToken) {
        const result = await api<{
          bot: { bot_username: string; bot_name: string };
        }>(
          "/api/admin/channels/telegram/setup",
          jsonBody({ botToken, enabled }),
        );
        await onSaved();
        notify(
          result.bot.bot_username
            ? `Telegram @${result.bot.bot_username} 已连接`
            : `Telegram ${result.bot.bot_name} 已连接`,
        );
        return;
      }
      if (preset === "telegram" && !value.id) {
        throw new Error("请填写 BotFather Token");
      }
      await api(
        "/api/admin/channels",
        jsonBody({
          id: value.id,
          name,
          type: "native",
          providerInstanceId,
          baseUrl,
          inboundToken: inboundToken || undefined,
          outboundToken: outboundToken || undefined,
          enabled,
        }),
      );
      await onSaved();
      notify("聊天 Adapter 已保存");
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        preset === "weclaw"
          ? "微信连接状态"
          : preset === "telegram"
          ? value.id
            ? "Telegram 设置"
            : "连接 Telegram"
          : value.id
            ? "编辑聊天 Adapter"
            : "添加聊天 Adapter"
      }
      subtitle={
        preset === "weclaw"
          ? "微信登录信息由同一 Compose 项目中的 WeClaw 自动提供，无需填写服务地址或认证令牌。"
          : preset === "telegram"
          ? "这里只需要 Telegram BotFather 提供的 Token，其余连接参数由系统自动处理。"
          : "账号实例 ID 必须与 Adapter 发送事件时使用的实例 ID 一致。"
      }
      width={preset === "generic" ? "760px" : "620px"}
      onClose={onClose}
    >
      <form className="modal-body form-stack" onSubmit={submit}>
        <Field label="Adapter 实现">
          <Select
            value={preset}
            onChange={(event) =>
              applyPreset(
                event.target.value as "weclaw" | "telegram" | "generic",
              )
            }
          >
            <option value="weclaw">WeClaw（微信）</option>
            <option value="telegram">Telegram Bot</option>
            <option value="generic">其他 Native Adapter</option>
          </Select>
        </Field>
        {preset === "weclaw" ? (
          <>
            <div className="telegram-setup-guide">
              <div>
                <span>1</span>
                <p>
                  <strong>登录微信</strong>
                  <small>在 WeClaw 启动时扫描登录二维码</small>
                </p>
              </div>
              <div>
                <span>2</span>
                <p>
                  <strong>自动识别</strong>
                  <small>AutoFilm 自动读取已登录账号并建立安全连接</small>
                </p>
              </div>
              <div>
                <span>3</span>
                <p>
                  <strong>绑定成员</strong>
                  <small>首次发送消息后，在成员页面处理新身份</small>
                </p>
              </div>
            </div>
            <div className="warning-note">
              {weClawStatus === null ? (
                "正在读取微信状态…"
              ) : !weClawStatus.available || !weClawStatus.configReady ? (
                "尚未检测到 WeClaw 配置。请检查 WeClaw 容器是否属于当前 Compose 项目。"
              ) : weClawStatus.accounts.length === 0 ? (
                "WeClaw 已运行，但尚未检测到登录成功的微信账号。"
              ) : (
                <>
                  <CheckCircle2 size={17} /> 已检测到{" "}
                  {weClawStatus.accounts.length} 个微信账号：
                  {weClawStatus.accounts
                    .map((account) => account.providerInstanceId)
                    .join("、")}
                </>
              )}
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void loadWeClawStatus()}
            >
              <RefreshCw size={15} /> 刷新状态
            </Button>
          </>
        ) : preset === "telegram" ? (
          <>
            <div className="telegram-setup-guide">
              <div>
                <span>1</span>
                <p>
                  <strong>创建机器人</strong>
                  <small>
                    在 Telegram 打开{" "}
                    <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                      @BotFather
                    </a>
                    ，发送 <code>/newbot</code>
                  </small>
                </p>
              </div>
              <div>
                <span>2</span>
                <p>
                  <strong>复制 Token</strong>
                  <small>BotFather 创建完成后会返回一段 Bot API Token</small>
                </p>
              </div>
              <div>
                <span>3</span>
                <p>
                  <strong>连接 AutoFilm</strong>
                  <small>粘贴到下方并保存，系统会验证机器人身份</small>
                </p>
              </div>
            </div>
            <Field
              label={value.id ? "更换 BotFather Token" : "BotFather Token"}
              hint={
                value.id
                  ? "无需更换时留空；当前 Token 不会从 Adapter 中读回"
                  : "示例格式：123456789:AA..."
              }
            >
              <Input
                type="password"
                value={botToken}
                onChange={(event) => setBotToken(event.target.value)}
                placeholder="粘贴 BotFather 返回的 Token"
                autoComplete="new-password"
                required={!value.id}
              />
            </Field>
            <div className="warning-note">
              保存后，直接在 Telegram 给机器人发送一条消息。首次联系会出现在
              AutoFilm“成员”页面，管理员绑定成员后即可使用。
            </div>
          </>
        ) : (
          <>
            <div className="form-grid">
              <Field label="名称">
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field label="账号实例 ID">
                <Input
                  value={providerInstanceId}
                  onChange={(e) => setProviderInstanceId(e.target.value)}
                  placeholder="wechat-main"
                  required
                />
              </Field>
            </div>
            <Field
              label="Adapter API 地址"
              hint="Core 主动发送任务完成通知时使用；仅聊天回复时可暂不填写"
            >
              <Input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://weclaw:18011"
              />
            </Field>
            <div className="token-toolbar">
              <div>
                <strong>双向认证令牌</strong>
                <span>两个方向必须使用不同令牌</span>
              </div>
              <Button type="button" variant="secondary" onClick={() => void generateTokens()}>
                <KeyRound size={15} /> 生成令牌
              </Button>
            </div>
            <div className="form-grid">
              <Field
                label="Adapter → Core"
                hint={
                  value.hasInboundToken
                    ? "留空保留当前值"
                    : "对应 Adapter 的入站认证令牌"
                }
              >
                <Input
                  type="password"
                  value={inboundToken}
                  onChange={(e) => setInboundToken(e.target.value)}
                />
              </Field>
              <Field
                label="Core → Adapter"
                hint={
                  value.hasOutboundToken
                    ? "留空保留当前值"
                    : "对应 Adapter 的出站认证令牌"
                }
              >
                <Input
                  type="password"
                  value={outboundToken}
                  onChange={(e) => setOutboundToken(e.target.value)}
                />
              </Field>
            </div>
            <div className="code-panel">
              <div className="code-panel-head">
                <span>
                  <Braces size={15} /> Native Adapter 配置
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(sample);
                    notify("配置已复制");
                  }}
                >
                  <Copy size={15} /> 复制
                </Button>
              </div>
              <pre>{sample}</pre>
            </div>
          </>
        )}
        <Toggle
          checked={enabled}
          onChange={setEnabled}
          label={preset === "weclaw" ? "允许通过微信使用 AutoFilm" : "启用此 Adapter"}
        />
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy}>
            {busy
              ? preset === "weclaw"
                ? "识别中…"
                : preset === "telegram"
                ? "连接中…"
                : "保存中…"
              : preset === "weclaw"
                ? "完成"
                : preset === "telegram"
                ? value.id && !botToken
                  ? "保存设置"
                  : "连接 Telegram"
                : "保存 Adapter"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
