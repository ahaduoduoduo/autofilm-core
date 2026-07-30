import { FormEvent, useEffect, useState } from "react";
import type { PromptConfigSummary } from "@autofilm/contracts";
import { FileText, Pencil, RotateCcw } from "lucide-react";
import { api, jsonBody } from "../lib/api.js";
import {
  Badge,
  Button,
  Card,
  Field,
  Loading,
  Modal,
  PageHeader,
  Textarea,
} from "../components/Ui.js";
import { useToast } from "../components/Toast.js";

export function PromptsPage() {
  const { notify } = useToast();
  const [prompts, setPrompts] = useState<PromptConfigSummary[] | null>(null);
  const [editing, setEditing] = useState<PromptConfigSummary | null>(null);

  async function load() {
    setPrompts(await api<PromptConfigSummary[]>("/api/admin/prompts"));
  }

  useEffect(() => void load(), []);
  if (!prompts) return <Loading />;

  return (
    <div>
      <PageHeader
        eyebrow="BEHAVIOR"
        title="提示词"
        description="提示词保存在 SQLite 中，修改后下一次模型请求立即生效。独立上下文不会继承主 Agent 提示词。"
      />
      <div className="card-grid">
        {prompts.map((prompt) => (
          <Card className="config-card" key={prompt.key}>
            <div className="config-card-head">
              <div className="config-icon">
                <FileText size={19} />
              </div>
              <div className="config-title">
                <strong>{prompt.name}</strong>
                <span>{prompt.key}</span>
              </div>
              <Badge tone={prompt.customized ? "warning" : "success"}>
                {prompt.customized ? "已自定义" : "系统默认"}
              </Badge>
            </div>
            <p className="config-description">{prompt.description}</p>
            <div className="config-meta">
              <span>{prompt.content.length.toLocaleString()} 字符</span>
              <span>默认版本 {prompt.defaultVersion}</span>
            </div>
            <div className="config-actions">
              <Button variant="secondary" onClick={() => setEditing(prompt)}>
                <Pencil size={15} /> 编辑
              </Button>
              <Button
                variant="ghost"
                disabled={!prompt.customized}
                onClick={() => void reset(prompt)}
              >
                <RotateCcw size={15} />
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {editing && (
        <PromptModal
          prompt={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
            notify("提示词已保存，下一次模型请求生效");
          }}
        />
      )}
    </div>
  );

  async function reset(prompt: PromptConfigSummary) {
    if (!window.confirm(`将“${prompt.name}”恢复为当前系统默认内容？`)) return;
    await api(`/api/admin/prompts/${encodeURIComponent(prompt.key)}/reset`, {
      method: "POST",
    });
    await load();
    notify("已恢复系统默认提示词");
  }
}

function PromptModal({
  prompt,
  onClose,
  onSaved,
}: {
  prompt: PromptConfigSummary;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { notify } = useToast();
  const [content, setContent] = useState(prompt.content);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(
        `/api/admin/prompts/${encodeURIComponent(prompt.key)}`,
        { ...jsonBody({ content }), method: "PUT" },
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
      title={`编辑 ${prompt.name}`}
      subtitle={prompt.description}
      width="980px"
      onClose={onClose}
    >
      <form className="modal-body form-stack" onSubmit={submit}>
        <Field
          label="提示词内容"
          hint={`${content.length.toLocaleString()} 字符；保存后不会修改既有聊天记录`}
        >
          <Textarea
            className="code-input prompt-editor"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            required
          />
        </Field>
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy}>{busy ? "保存中…" : "保存提示词"}</Button>
        </div>
      </form>
    </Modal>
  );
}
