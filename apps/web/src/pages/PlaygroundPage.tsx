import { FormEvent, useState } from "react";
import {
  Bot,
  CircleUserRound,
  Eraser,
  Send,
  Sparkles,
} from "lucide-react";
import { api, jsonBody } from "../lib/api.js";
import {
  Button,
  Card,
  PageHeader,
  Textarea,
} from "../components/Ui.js";
import { useToast } from "../components/Toast.js";

interface ChatItem {
  role: "user" | "assistant";
  content: string;
}

export function PlaygroundPage() {
  const { notify } = useToast();
  const [message, setMessage] = useState("");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || busy) return;
    setItems((current) => [...current, { role: "user", content: text }]);
    setMessage("");
    setBusy(true);
    try {
      const response = await api<{ content: string }>(
        "/api/admin/agent/test",
        jsonBody({ message: text }),
      );
      setItems((current) => [
        ...current,
        { role: "assistant", content: response.content },
      ]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Agent 请求失败", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="PLAYGROUND"
        title="Agent 测试"
        description="以当前管理员身份直接测试默认模型、工具和媒体服务，不经过聊天 Adapter。"
        actions={
          <Button
            variant="secondary"
            onClick={() => setItems([])}
            disabled={!items.length || busy}
          >
            <Eraser size={16} /> 清空显示
          </Button>
        }
      />
      <Card className="playground">
        <div className="playground-head">
          <div className="agent-avatar">
            <Sparkles size={18} />
          </div>
          <div>
            <strong>AutoFilm Agent</strong>
            <span>
              <i /> 使用默认模型
            </span>
          </div>
        </div>
        <div className="chat-window">
          {items.length === 0 ? (
            <div className="chat-welcome">
              <div className="chat-welcome-icon">
                <Bot size={28} />
              </div>
              <h2>测试一句真实请求</h2>
              <p>
                例如：“帮我找 2024 年的沙丘第二部，先列出版本，不要直接下载。”
              </p>
              <div className="suggestion-row">
                {[
                  "最近有什么热门电影？",
                  "Jellyfin 里有星际穿越吗？",
                  "查看我的下载进度",
                ].map((suggestion) => (
                  <button key={suggestion} onClick={() => setMessage(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-items">
              {items.map((item, index) => (
                <div className={`chat-item chat-${item.role}`} key={index}>
                  <span className="chat-avatar">
                    {item.role === "assistant" ? (
                      <Bot size={17} />
                    ) : (
                      <CircleUserRound size={17} />
                    )}
                  </span>
                  <div>{item.content}</div>
                </div>
              ))}
              {busy && (
                <div className="chat-item chat-assistant">
                  <span className="chat-avatar">
                    <Bot size={17} />
                  </span>
                  <div className="typing">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <form className="chat-composer" onSubmit={submit}>
          <Textarea
            rows={2}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="输入一个观影请求…"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button disabled={busy || !message.trim()} aria-label="发送">
            <Send size={17} />
          </Button>
        </form>
      </Card>
    </div>
  );
}
