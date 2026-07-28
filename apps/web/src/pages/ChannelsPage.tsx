import { FormEvent, useEffect, useMemo, useState } from "react";
import type { ChannelConfigSummary } from "@autofilm/contracts";
import {
  Braces,
  CirclePlus,
  Copy,
  KeyRound,
  MessageSquareMore,
  Pencil,
  Radio,
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
  Toggle,
} from "../components/Ui.js";
import { useToast } from "../components/Toast.js";

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
            WeClaw 是微信 Adapter；以后可用相同协议增加 Telegram
            或其他聊天工具。业务规则、成员权限和会话仍由 Core 保存。
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
            notify("聊天 Adapter 已保存");
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
  const [name, setName] = useState(value.name ?? "WeClaw");
  const [providerInstanceId, setProviderInstanceId] = useState(
    value.providerInstanceId ?? "",
  );
  const [baseUrl, setBaseUrl] = useState(value.baseUrl ?? "");
  const [inboundToken, setInboundToken] = useState("");
  const [outboundToken, setOutboundToken] = useState("");
  const [enabled, setEnabled] = useState(value.enabled ?? true);
  const [busy, setBusy] = useState(false);

  const sample = useMemo(
    () =>
      JSON.stringify(
        {
          default_agent: "autofilm",
          api_addr: "0.0.0.0:18011",
          agents: {
            autofilm: {
              type: "native",
              endpoint:
                "http://autofilm-core:3100/v1/conversation/events",
              api_key: inboundToken || "<core-inbound-token>",
              outbound_token: outboundToken || "<weclaw-outbound-token>",
              allowed_users: ["*"],
              timeout_seconds: 180,
            },
          },
        },
        null,
        2,
      ),
    [inboundToken, outboundToken],
  );

  async function generateTokens() {
    const first = await api<{ token: string }>("/api/admin/channels/token", {
      method: "POST",
    });
    const second = await api<{ token: string }>("/api/admin/channels/token", {
      method: "POST",
    });
    setInboundToken(first.token);
    setOutboundToken(second.token);
    notify("已生成两组不同的随机令牌；保存前复制 WeClaw 配置");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
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
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={value.id ? "编辑聊天 Adapter" : "添加聊天 Adapter"}
      subtitle="provider_instance_id 必须与 Adapter 发送事件时使用的账号实例 ID 一致。"
      width="760px"
      onClose={onClose}
    >
      <form className="modal-body form-stack" onSubmit={submit}>
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
            hint={value.hasInboundToken ? "留空保留当前值" : "对应 WeClaw api_key"}
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
                : "对应 WeClaw outbound_token"
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
              <Braces size={15} /> WeClaw 配置示例
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
        <div className="warning-note">
          多人申请模式下，WeClaw 可在私有容器网络中使用{" "}
          <code>allowed_users: ["*"]</code>，实际授权由 Core
          的成员绑定处理；公网暴露 WeClaw API 不属于安全配置。
        </div>
        <Toggle checked={enabled} onChange={setEnabled} label="启用此 Adapter" />
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy}>{busy ? "保存中…" : "保存 Adapter"}</Button>
        </div>
      </form>
    </Modal>
  );
}
