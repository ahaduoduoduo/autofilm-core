import { FormEvent, useEffect, useState } from "react";
import type {
  ServiceConfigSummary,
  ServiceType,
} from "@autofilm/contracts";
import { DEFAULT_MEDIA_LIBRARY_ROOTS } from "@autofilm/contracts";
import {
  Boxes,
  CirclePlus,
  Clapperboard,
  Cloud,
  KeyRound,
  Pencil,
  QrCode,
  Search,
  Subtitles,
  TestTube2,
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

const serviceInfo: Record<
  ServiceType,
  { label: string; description: string; icon: typeof Cloud; defaultUrl: string }
> = {
  openlist: {
    label: "OpenList",
    description: "网盘文件、离线下载与任务进度",
    icon: Cloud,
    defaultUrl: "http://openlist:5244",
  },
  jellyfin: {
    label: "Jellyfin",
    description: "媒体库查询和远端目录精确刷新",
    icon: Clapperboard,
    defaultUrl: "http://jellyfin:8096",
  },
  jackett: {
    label: "Jackett",
    description: "聚合检索可下载发布版本",
    icon: Search,
    defaultUrl: "http://jackett:9117",
  },
  tmdb: {
    label: "TMDB",
    description: "影片身份、海报和播出信息",
    icon: Boxes,
    defaultUrl: "https://api.themoviedb.org/3",
  },
  subhd: {
    label: "SubHD",
    description: "字幕搜索、详情、下载与验证码处理",
    icon: Subtitles,
    defaultUrl: "https://subhd.tv",
  },
};

export function ServicesPage() {
  const { notify } = useToast();
  const [services, setServices] = useState<ServiceConfigSummary[] | null>(null);
  const [editing, setEditing] =
    useState<Partial<ServiceConfigSummary> | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [authService, setAuthService] =
    useState<ServiceConfigSummary | null>(null);

  async function load() {
    setServices(await api("/api/admin/services"));
  }
  useEffect(() => void load(), []);
  if (!services) return <Loading />;

  return (
    <div>
      <PageHeader
        eyebrow="INTEGRATIONS"
        title="媒体服务"
        description="Core 通过各服务的正式 API 工作；网盘差异留在 OpenList 内部，不进入 Agent 和 Jellyfin 的数据模型。"
        actions={
          <Button onClick={() => setEditing({ type: "openlist", enabled: true })}>
            <CirclePlus size={17} /> 添加服务
          </Button>
        }
      />
      {services.length ? (
        <div className="card-grid">
          {services.map((service) => {
            const info = serviceInfo[service.type];
            const Icon = info.icon;
            return (
              <Card className="config-card" key={service.id}>
                <div className="config-card-head">
                  <div className="config-icon">
                    <Icon size={19} />
                  </div>
                  <div className="config-title">
                    <strong>{service.name}</strong>
                    <span>{info.label}</span>
                  </div>
                  <Badge tone={service.enabled ? "success" : "neutral"}>
                    {service.enabled ? "启用" : "停用"}
                  </Badge>
                </div>
                <p className="config-description">{info.description}</p>
                <div className="config-url">
                  {service.baseUrl || info.defaultUrl}
                </div>
                <div className="config-meta">
                  <span>
                    <KeyRound size={14} />
                    {service.hasCredential ? "已保存凭据" : "无凭据"}
                  </span>
                </div>
                <div className="config-actions">
                  {service.type === "openlist" && (
                    <Button
                      variant="secondary"
                      onClick={() => setAuthService(service)}
                    >
                      <QrCode size={15} /> 115 登录
                    </Button>
                  )}
                  <Button
                    variant={service.type === "openlist" ? "ghost" : "secondary"}
                    disabled={testing === service.id}
                    onClick={() => void test(service)}
                  >
                    <TestTube2 size={15} />
                    {testing === service.id ? "测试中…" : "测试"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setEditing(service)}
                  >
                    <Pencil size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void remove(service.id)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<Boxes size={24} />}
            title="还没有媒体服务"
            description="至少配置 OpenList、Jellyfin、Jackett 和 TMDB，Agent 才能完成完整的找片与下载过程。"
            action={
              <Button onClick={() => setEditing({ type: "openlist", enabled: true })}>
                添加第一个服务
              </Button>
            }
          />
        </Card>
      )}
      <div className="service-hints">
        {(Object.keys(serviceInfo) as ServiceType[]).map((type) => {
          const item = serviceInfo[type];
          const Icon = item.icon;
          const configured = services.some(
            (service) => service.type === type && service.enabled,
          );
          return (
            <button
              key={type}
              className={`service-hint ${configured ? "service-configured" : ""}`}
              onClick={() =>
                setEditing({
                  type,
                  enabled: true,
                  baseUrl: item.defaultUrl,
                  name: item.label,
                })
              }
            >
              <Icon size={17} />
              <span>
                <strong>{item.label}</strong>
                <small>{configured ? "已配置" : "待配置"}</small>
              </span>
            </button>
          );
        })}
      </div>
      {editing && (
        <ServiceModal
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            notify("媒体服务已保存");
          }}
        />
      )}
      {authService && (
        <OpenListAuthModal
          service={authService}
          onClose={() => setAuthService(null)}
        />
      )}
    </div>
  );

  async function test(service: ServiceConfigSummary) {
    setTesting(service.id);
    try {
      await api(`/api/admin/services/${service.id}/test`, { method: "POST" });
      notify(`${service.name} 连接正常`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "连接失败", "error");
    } finally {
      setTesting(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("删除这个媒体服务配置？")) return;
    await api(`/api/admin/services/${id}`, { method: "DELETE" });
    await load();
    notify("服务已删除");
  }
}

function ServiceModal({
  value,
  onClose,
  onSaved,
}: {
  value: Partial<ServiceConfigSummary>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { notify } = useToast();
  const [type, setType] = useState<ServiceType>(value.type ?? "openlist");
  const [name, setName] = useState(value.name ?? serviceInfo[type].label);
  const [baseUrl, setBaseUrl] = useState(
    value.baseUrl ?? serviceInfo[type].defaultUrl,
  );
  const [credential, setCredential] = useState("");
  const [enabled, setEnabled] = useState(value.enabled ?? true);
  const [options, setOptions] = useState<Record<string, unknown>>(
    { ...defaultOptions(type), ...(value.options ?? {}) },
  );
  const [busy, setBusy] = useState(false);

  function changeType(next: ServiceType) {
    setType(next);
    setName(serviceInfo[next].label);
    setBaseUrl(serviceInfo[next].defaultUrl);
    setOptions(defaultOptions(next));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(
        "/api/admin/services",
        jsonBody({
          id: value.id,
          name,
          type,
          baseUrl,
          credential: credential || undefined,
          options,
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
    <Modal title={value.id ? "编辑媒体服务" : "添加媒体服务"} onClose={onClose}>
      <form className="modal-body form-stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="类型">
            <Select
              value={type}
              onChange={(e) => changeType(e.target.value as ServiceType)}
              disabled={Boolean(value.id)}
            >
              {(Object.keys(serviceInfo) as ServiceType[]).map((key) => (
                <option value={key} key={key}>
                  {serviceInfo[key].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
        </div>
        <Field label="Base URL">
          <Input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
          />
        </Field>
        {type !== "subhd" && (
          <Field
            label={credentialLabel(type)}
            hint={value.hasCredential ? "留空表示保留当前值" : credentialHint(type)}
          >
            <Input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
        )}
        {type === "openlist" && (
          <>
            <div className="form-grid">
              <Field
                label="电影媒体库根目录"
                hint="Core 会在下面按月份创建下载目录"
              >
                <Input
                  value={String(
                    options.movieLibraryRoot ??
                      DEFAULT_MEDIA_LIBRARY_ROOTS.movie,
                  )}
                  onChange={(e) =>
                    setOptions((current) => ({
                      ...current,
                      movieLibraryRoot: e.target.value,
                    }))
                  }
                  required
                />
              </Field>
              <Field
                label="电视剧媒体库根目录"
                hint="单季进入剧名/Sxx，多季合集进入剧名根目录"
              >
                <Input
                  value={String(
                    options.tvLibraryRoot ?? DEFAULT_MEDIA_LIBRARY_ROOTS.tv,
                  )}
                  onChange={(e) =>
                    setOptions((current) => ({
                      ...current,
                      tvLibraryRoot: e.target.value,
                    }))
                  }
                  required
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="离线下载工具">
                <Input
                  value={String(options.offlineDownloadTool ?? "115 Cloud")}
                  onChange={(e) =>
                    setOptions((current) => ({
                      ...current,
                      offlineDownloadTool: e.target.value,
                    }))
                  }
                />
              </Field>
              <Field
                label="115 Storage ID"
                hint="仅用于管理扫码会话，不进入 Jellyfin 媒体模型"
              >
                <Input
                  type="number"
                  min="1"
                  value={String(options.authStorageId ?? "")}
                  onChange={(e) =>
                    setOptions((current) => ({
                      ...current,
                      authStorageId: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    }))
                  }
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field
                label="115 秒传时限（秒）"
                hint="超过时限即停止当前任务并询问是否使用备用资源；建议 40 秒"
              >
                <Input
                  type="number"
                  min="10"
                  max="120"
                  value={String(options.instantOfflineTimeoutSeconds ?? 40)}
                  onChange={(e) =>
                    setOptions((current) => ({
                      ...current,
                      instantOfflineTimeoutSeconds:
                        Number(e.target.value) || 40,
                    }))
                  }
                />
              </Field>
              <Toggle
                checked={
                  (options.instantOfflineTimeoutEnabled ??
                    options.instantOfflineRetryEnabled) !== false
                }
                onChange={(checked) =>
                  setOptions((current) => ({
                    ...current,
                    instantOfflineTimeoutEnabled: checked,
                  }))
                }
                label="启用秒传时限判断"
              />
            </div>
          </>
        )}
        {type === "jackett" && (
          <Field label="结果接口路径">
            <Input
              value={String(
                options.path ?? "/api/v2.0/indexers/all/results",
              )}
              onChange={(e) =>
                setOptions((current) => ({ ...current, path: e.target.value }))
              }
            />
          </Field>
        )}
        {type === "tmdb" && (
          <Field label="语言">
            <Input
              value={String(options.language ?? "zh-CN")}
              onChange={(e) =>
                setOptions((current) => ({
                  ...current,
                  language: e.target.value,
                }))
              }
            />
          </Field>
        )}
        {type === "subhd" && (
          <Field
            label="请求间隔（毫秒）"
            hint="SubHD 请求串行执行；增加间隔可降低被限流概率"
          >
            <Input
              type="number"
              min="500"
              value={String(options.requestDelayMs ?? 800)}
              onChange={(e) =>
                setOptions((current) => ({
                  ...current,
                  requestDelayMs: Number(e.target.value) || 800,
                }))
              }
            />
          </Field>
        )}
        <Toggle checked={enabled} onChange={setEnabled} label="启用此服务" />
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy}>{busy ? "保存中…" : "保存服务"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function defaultOptions(type: ServiceType): Record<string, unknown> {
  if (type === "openlist")
    return {
      offlineDownloadTool: "115 Cloud",
      instantOfflineTimeoutEnabled: true,
      instantOfflineTimeoutSeconds: 40,
      movieLibraryRoot: DEFAULT_MEDIA_LIBRARY_ROOTS.movie,
      tvLibraryRoot: DEFAULT_MEDIA_LIBRARY_ROOTS.tv,
    };
  if (type === "jackett")
    return { path: "/api/v2.0/indexers/all/results" };
  if (type === "tmdb") return { language: "zh-CN" };
  if (type === "subhd") return { requestDelayMs: 800 };
  return {};
}

interface AuthSession {
  session_id: string;
  state: string;
  expires_at: string;
  message?: string;
}

function OpenListAuthModal({
  service,
  onClose,
}: {
  service: ServiceConfigSummary;
  onClose: () => void;
}) {
  const { notify } = useToast();
  const storageId = Number(service.options.authStorageId);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    if (!Number.isInteger(storageId) || storageId <= 0) {
      notify("先在 OpenList 服务配置中填写 115 Storage ID", "error");
      return;
    }
    setBusy(true);
    try {
      setSession(
        await api(
          `/api/admin/services/${service.id}/openlist/auth-sessions`,
          jsonBody({ storageId }),
        ),
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "扫码会话创建失败", "error");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (
      !session ||
      ["confirmed", "expired", "failed", "canceled"].includes(session.state)
    ) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const next = await api<AuthSession>(
          `/api/admin/services/${service.id}/openlist/auth-sessions/${session.session_id}?storageId=${storageId}`,
        );
        setSession(next);
        if (next.state === "confirmed") {
          notify("115 登录信息已由 OpenList 自动更新");
        }
      } catch {
        window.clearInterval(timer);
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [notify, service.id, session, storageId]);

  const complete =
    session?.state === "confirmed";
  return (
    <Modal
      title="115 扫码登录"
      subtitle="二维码和 Cookie 均由 OpenList 的 115 驱动管理；Core 不保存 Cookie。"
      onClose={onClose}
      width="460px"
    >
      <div className="modal-body form-stack">
        {!session ? (
          <div className="qr-placeholder">
            <QrCode size={48} />
            <strong>创建扫码会话</strong>
            <p>
              使用 OpenList Storage ID {Number.isFinite(storageId) ? storageId : "—"}，
              保留该存储原有客户端类型等设置。
            </p>
          </div>
        ) : (
          <div className="qr-session">
            <img
              src={`/api/admin/services/${service.id}/openlist/auth-sessions/${session.session_id}/qrcode.png?storageId=${storageId}`}
              alt="115 登录二维码"
            />
            <Badge tone={complete ? "success" : "warning"}>
              {complete ? "登录完成" : session.message || session.state}
            </Badge>
            <span>
              有效期至{" "}
              {new Date(session.expires_at).toLocaleString("zh-CN", {
                hour12: false,
              })}
            </span>
          </div>
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
          {!complete && (
            <Button onClick={() => void start()} disabled={busy}>
              <QrCode size={15} /> {session ? "刷新二维码" : "生成二维码"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function credentialLabel(type: ServiceType): string {
  if (type === "openlist") return "OpenList AutoFilm 服务 Token";
  if (type === "jellyfin") return "Jellyfin API Key";
  if (type === "jackett") return "Jackett API Key";
  if (type === "subhd") return "不需要凭据";
  return "TMDB Read Access Token / v3 API Key";
}

function credentialHint(type: ServiceType): string {
  if (type === "openlist")
    return "受限于 /api/autofilm；不能访问普通管理接口，115 Cookie 不会进入 Core";
  if (type === "subhd") return "SubHD 使用公开网页接口";
  return "凭据使用主密钥加密后保存在 Core 数据库";
}
