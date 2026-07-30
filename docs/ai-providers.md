# AI suppliers and protocols

Updated: 2026-07-29

## 两个独立概念

供应方配置包含名称、Base URL、密钥和附加请求头。协议配置决定 URL
后缀、请求体、工具调用和响应解析。

例如 New API、自建网关和官方 API 都可以选择 `openai-responses`；
Core 不检查供应方名称，也没有 `newapi` 分支。

## 协议

| 协议 | Core 请求路径 | 用途 |
| --- | --- | --- |
| `openai-responses` | `responses` | 默认新协议 |
| `openai-chat-completions` | `chat/completions` | 旧式兼容接口 |
| `anthropic-messages` | `messages` | Anthropic 原生 |
| `gemini-generate-content` | `models/{model}:generateContent` | Gemini 原生 |

Base URL 应包含版本前缀，例如 `https://provider.example/v1`。Core
在其后追加表中路径。

`openai-responses` 使用标准 `stream: true` 模式，由 Core 在服务端解析 SSE
文本、用量和工具调用事件。模型测试、主 Agent 和验证码上下文仍接收聚合后的
完整结果；兼容层也接受供应方在流式请求后返回普通 JSON。

模型配置引用供应方，并保存真实 `model` 值、是否默认、temperature
和最大输出 Token。只有一个模型可设为默认。

## 工具抽象

Agent 内部统一使用 `ToolDefinition`、`ToolCall` 和 `CanonicalMessage`。
各协议 Adapter 只负责格式转换，媒体业务代码不依赖任何供应方 SDK。

密钥和附加请求头由 Core 主密钥使用 AES-256-GCM 加密。管理 API
只返回“是否已保存”，不返回原文。
