import { FormEvent, useEffect, useState } from "react";
import type {
  AiProtocol,
  AiProviderSummary,
  ModelProfile,
} from "@autofilm/contracts";
import {
  Bot,
  BrainCircuit,
  Check,
  CirclePlus,
  KeyRound,
  Pencil,
  Play,
  Server,
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
  Textarea,
  Toggle,
} from "../components/Ui.js";
import { useToast } from "../components/Toast.js";

const protocols: Array<{ value: AiProtocol; label: string; note: string }> = [
  {
    value: "openai-responses",
    label: "OpenAI Responses",
    note: "默认；支持新的 Responses 与工具调用格式",
  },
  {
    value: "openai-chat-completions",
    label: "OpenAI Chat Completions",
    note: "兼容旧式 OpenAI 接口和代理",
  },
  {
    value: "anthropic-messages",
    label: "Anthropic Messages",
    note: "Anthropic 原生消息协议",
  },
  {
    value: "gemini-generate-content",
    label: "Gemini GenerateContent",
    note: "Google Gemini 原生协议",
  },
];

export function AiPage() {
  const { notify } = useToast();
  const [providers, setProviders] = useState<AiProviderSummary[] | null>(null);
  const [models, setModels] = useState<ModelProfile[]>([]);
  const [providerEdit, setProviderEdit] =
    useState<Partial<AiProviderSummary> | null>(null);
  const [modelEdit, setModelEdit] = useState<Partial<ModelProfile> | null>(null);
  const [testModel, setTestModel] = useState<ModelProfile | null>(null);

  async function load() {
    const [providerList, modelList] = await Promise.all([
      api<AiProviderSummary[]>("/api/admin/ai/providers"),
      api<ModelProfile[]>("/api/admin/ai/models"),
    ]);
    setProviders(providerList);
    setModels(modelList);
  }
  useEffect(() => void load(), []);

  if (!providers) return <Loading />;
  return (
    <div>
      <PageHeader
        eyebrow="INTELLIGENCE"
        title="AI 与模型"
        description="供应方只提供地址和凭据，协议决定请求格式；New API 可作为任意一个供应方实例。"
        actions={
          <Button onClick={() => setProviderEdit({ enabled: true })}>
            <CirclePlus size={17} /> 添加供应方
          </Button>
        }
      />
      <section className="section-block">
        <div className="section-title">
          <div>
            <h2>供应方</h2>
            <p>同一种协议可配置多个不同供应方。</p>
          </div>
        </div>
        {providers.length ? (
          <div className="card-grid">
            {providers.map((provider) => (
              <Card className="config-card" key={provider.id}>
                <div className="config-card-head">
                  <div className="config-icon">
                    <Server size={19} />
                  </div>
                  <div className="config-title">
                    <strong>{provider.name}</strong>
                    <span>{protocolName(provider.protocol)}</span>
                  </div>
                  <Badge tone={provider.enabled ? "success" : "neutral"}>
                    {provider.enabled ? "启用" : "停用"}
                  </Badge>
                </div>
                <div className="config-url">{provider.baseUrl}</div>
                <div className="config-meta">
                  <span>
                    <KeyRound size={14} />
                    {provider.hasApiKey ? "已保存密钥" : "无密钥"}
                  </span>
                  <span>
                    <BrainCircuit size={14} />
                    {
                      models.filter((model) => model.providerId === provider.id)
                        .length
                    }{" "}
                    个模型
                  </span>
                </div>
                <div className="config-actions">
                  <Button
                    variant="secondary"
                    onClick={() => setProviderEdit(provider)}
                  >
                    <Pencil size={15} /> 编辑
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void removeProvider(provider.id)}
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
              icon={<Bot size={24} />}
              title="还没有 AI 供应方"
              description="添加任意支持所选协议的 API 服务。供应方名称只是便于识别，不影响协议。"
              action={
                <Button onClick={() => setProviderEdit({ enabled: true })}>
                  添加第一个供应方
                </Button>
              }
            />
          </Card>
        )}
      </section>
      <section className="section-block">
        <div className="section-title">
          <div>
            <h2>模型配置</h2>
            <p>默认模型用于聊天 Agent；可在同一供应方下创建多个配置。</p>
          </div>
          <Button
            variant="secondary"
            disabled={!providers.length}
            onClick={() =>
              setModelEdit({
                providerId: providers[0]?.id,
                enabled: true,
                isDefault: models.length === 0,
                contextWindowTokens: 128_000,
                autoCompactTokenLimit: null,
                toolOutputTokenLimit: 12_000,
              })
            }
          >
            <CirclePlus size={16} /> 添加模型
          </Button>
        </div>
        <Card className="table-card">
          {models.length ? (
            <div className="data-table">
              <div className="data-row data-head model-row">
                <span>名称</span>
                <span>模型 ID</span>
                <span>供应方</span>
                <span>状态</span>
                <span />
              </div>
              {models.map((model) => (
                <div className="data-row model-row" key={model.id}>
                  <span className="primary-cell">
                    <span className="mini-icon">
                      <BrainCircuit size={15} />
                    </span>
                    {model.name}
                    {model.isDefault && (
                      <Badge tone="accent">
                        <Check size={12} /> 默认
                      </Badge>
                    )}
                  </span>
                  <code>{model.model}</code>
                  <span>
                    {providers.find((item) => item.id === model.providerId)?.name ??
                      "未知"}
                  </span>
                  <Badge tone={model.enabled ? "success" : "neutral"}>
                    {model.enabled ? "可用" : "停用"}
                  </Badge>
                  <span className="row-actions">
                    <Button variant="ghost" onClick={() => setTestModel(model)}>
                      <Play size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setModelEdit(model)}
                    >
                      <Pencil size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void removeModel(model.id)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<BrainCircuit size={24} />}
              title="还没有模型配置"
              description="添加供应方后，填写供应方实际支持的模型 ID。"
            />
          )}
        </Card>
      </section>

      {providerEdit && (
        <ProviderModal
          value={providerEdit}
          onClose={() => setProviderEdit(null)}
          onSaved={async () => {
            setProviderEdit(null);
            await load();
            notify("AI 供应方已保存");
          }}
        />
      )}
      {modelEdit && (
        <ModelModal
          value={modelEdit}
          providers={providers}
          onClose={() => setModelEdit(null)}
          onSaved={async () => {
            setModelEdit(null);
            await load();
            notify("模型配置已保存");
          }}
        />
      )}
      {testModel && (
        <TestModal model={testModel} onClose={() => setTestModel(null)} />
      )}
    </div>
  );

  async function removeProvider(id: string) {
    if (!window.confirm("删除供应方会同时删除其模型配置。")) return;
    try {
      await api(`/api/admin/ai/providers/${id}`, { method: "DELETE" });
      await load();
      notify("供应方已删除");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败", "error");
    }
  }

  async function removeModel(id: string) {
    if (!window.confirm("删除这个模型配置？")) return;
    await api(`/api/admin/ai/models/${id}`, { method: "DELETE" });
    await load();
    notify("模型配置已删除");
  }
}

function ProviderModal({
  value,
  onClose,
  onSaved,
}: {
  value: Partial<AiProviderSummary>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { notify } = useToast();
  const [name, setName] = useState(value.name ?? "");
  const [protocol, setProtocol] = useState<AiProtocol>(
    value.protocol ?? "openai-responses",
  );
  const [baseUrl, setBaseUrl] = useState(value.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState(
    JSON.stringify(value.customHeaders ?? {}, null, 2),
  );
  const [enabled, setEnabled] = useState(value.enabled ?? true);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const customHeaders = JSON.parse(headers) as Record<string, string>;
      await api(
        "/api/admin/ai/providers",
        jsonBody({
          id: value.id,
          name,
          protocol,
          baseUrl,
          apiKey: apiKey || undefined,
          customHeaders,
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
      title={value.id ? "编辑 AI 供应方" : "添加 AI 供应方"}
      subtitle="供应方名称不参与请求；协议和 Base URL 决定真实接口。"
      onClose={onClose}
    >
      <form className="modal-body form-stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="协议">
            <Select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as AiProtocol)}
            >
              {protocols.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Base URL" hint="通常以 /v1 结尾；不要填写具体的 responses 路径">
          <Input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://provider.example/v1"
            required
          />
        </Field>
        <Field
          label="API Key"
          hint={value.hasApiKey ? "留空表示保留当前密钥" : "无密钥接口可留空"}
        >
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label="附加请求头（JSON）">
          <Textarea
            className="code-input"
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            rows={4}
          />
        </Field>
        <Toggle checked={enabled} onChange={setEnabled} label="启用此供应方" />
        <div className="protocol-note">
          {protocols.find((item) => item.value === protocol)?.note}
        </div>
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy}>{busy ? "保存中…" : "保存供应方"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ModelModal({
  value,
  providers,
  onClose,
  onSaved,
}: {
  value: Partial<ModelProfile>;
  providers: AiProviderSummary[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { notify } = useToast();
  const [form, setForm] = useState({
    name: value.name ?? "",
    model: value.model ?? "",
    providerId: value.providerId ?? providers[0]?.id ?? "",
    temperature: value.temperature?.toString() ?? "",
    maxOutputTokens: value.maxOutputTokens?.toString() ?? "",
    contextWindowTokens: (value.contextWindowTokens ?? 128_000).toString(),
    autoCompactTokenLimit: value.autoCompactTokenLimit?.toString() ?? "",
    toolOutputTokenLimit: (value.toolOutputTokenLimit ?? 12_000).toString(),
    isDefault: value.isDefault ?? false,
    enabled: value.enabled ?? true,
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await api(
        "/api/admin/ai/models",
        jsonBody({
          id: value.id,
          providerId: form.providerId,
          name: form.name,
          model: form.model,
          temperature: form.temperature ? Number(form.temperature) : null,
          maxOutputTokens: form.maxOutputTokens
            ? Number(form.maxOutputTokens)
            : null,
          contextWindowTokens: Number(form.contextWindowTokens),
          autoCompactTokenLimit: form.autoCompactTokenLimit
            ? Number(form.autoCompactTokenLimit)
            : null,
          toolOutputTokenLimit: Number(form.toolOutputTokenLimit),
          isDefault: form.isDefault,
          enabled: form.enabled,
        }),
      );
      await onSaved();
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败", "error");
    }
  }
  const change = (key: keyof typeof form, value: string | boolean) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <Modal title={value.id ? "编辑模型" : "添加模型"} onClose={onClose}>
      <form className="modal-body form-stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="显示名称">
            <Input
              value={form.name}
              onChange={(e) => change("name", e.target.value)}
              required
            />
          </Field>
          <Field label="供应方">
            <Select
              value={form.providerId}
              onChange={(e) => change("providerId", e.target.value)}
            >
              {providers.map((provider) => (
                <option value={provider.id} key={provider.id}>
                  {provider.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="form-grid">
          <Field
            label="上下文窗口 Token"
            hint="填写供应方为这个模型提供的完整上下文窗口"
          >
            <Input
              type="number"
              min="8192"
              max="2000000"
              value={form.contextWindowTokens}
              onChange={(e) => change("contextWindowTokens", e.target.value)}
              required
            />
          </Field>
          <Field
            label="自动压缩 Token 阈值"
            hint="留空使用窗口的 80%；最高允许 90%"
          >
            <Input
              type="number"
              min="4096"
              max="1800000"
              value={form.autoCompactTokenLimit}
              onChange={(e) => change("autoCompactTokenLimit", e.target.value)}
            />
          </Field>
        </div>
        <Field
          label="单工具输出 Token 预算"
          hint="只限制发送给模型的视图；SQLite 保留工具原始结果"
        >
          <Input
            type="number"
            min="512"
            max="100000"
            value={form.toolOutputTokenLimit}
            onChange={(e) => change("toolOutputTokenLimit", e.target.value)}
            required
          />
        </Field>
        <Field label="模型 ID" hint="填写供应方接口实际接受的 model 值">
          <Input
            value={form.model}
            onChange={(e) => change("model", e.target.value)}
            required
          />
        </Field>
        <div className="form-grid">
          <Field label="Temperature" hint="留空使用供应方默认值">
            <Input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={form.temperature}
              onChange={(e) => change("temperature", e.target.value)}
            />
          </Field>
          <Field label="最大输出 Token" hint="留空使用供应方默认值">
            <Input
              type="number"
              min="1"
              value={form.maxOutputTokens}
              onChange={(e) => change("maxOutputTokens", e.target.value)}
            />
          </Field>
        </div>
        <Toggle
          checked={form.isDefault}
          onChange={(value) => change("isDefault", value)}
          label="作为聊天 Agent 默认模型"
        />
        <Toggle
          checked={form.enabled}
          onChange={(value) => change("enabled", value)}
          label="启用此模型配置"
        />
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button>保存模型</Button>
        </div>
      </form>
    </Modal>
  );
}

function TestModal({
  model,
  onClose,
}: {
  model: ModelProfile;
  onClose: () => void;
}) {
  const { notify } = useToast();
  const [message, setMessage] = useState("请用一句话说明你可以正常响应。");
  const [result, setResult] = useState<{
    content: string;
    inputTokens: number;
    outputTokens: number;
    elapsedMs: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      setResult(
        await api("/api/admin/ai/test", jsonBody({ modelId: model.id, message })),
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "测试失败", "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`测试 ${model.name}`} onClose={onClose}>
      <div className="modal-body form-stack">
        <Field label="测试消息">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
          />
        </Field>
        {result && (
          <div className="test-result">
            <p>{result.content}</p>
            <span>
              {result.elapsedMs} ms · {result.inputTokens} + {result.outputTokens}{" "}
              tokens
            </span>
          </div>
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
          <Button onClick={() => void run()} disabled={busy || !message.trim()}>
            <Play size={15} /> {busy ? "测试中…" : "发送测试"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function protocolName(protocol: AiProtocol): string {
  return protocols.find((item) => item.value === protocol)?.label ?? protocol;
}
