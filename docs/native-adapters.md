# Native chat adapters

Updated: 2026-07-29

Core 实现 WeClaw `Native Message Service 2026-07-01`。完整通用协议也记录在
WeClaw fork 的 `docs/native-services.md`。

## WeClaw 配置

官方 Compose 将 `weclaw/` 同时挂载给 WeClaw 和 Core。Core 只读访问该目录，
自动识别 `accounts/` 中的登录账号及 `config.json` 中的 Native Agent 配置。
扫码完成后无需在管理界面填写 `provider_instance_id`、服务地址或双向令牌。

WeClaw 的独立管理界面默认发布在 `http://主机地址:18011`。浏览器可以直接添加
微信登录账号、配置其他 Agent，并按联系人分配可用 Agent。AutoFilm 页面只管理
AutoFilm 自身看到的微信渠道和成员身份。

自动识别使用：

- `AUTOFILM_WECLAW_DATA_DIR=/weclaw`
- `AUTOFILM_WECLAW_URL=http://weclaw:18011`

下面的配置只用于独立部署或开发其他 Native Adapter，不属于日常管理步骤。

```json
{
  "default_agent": "autofilm",
  "api_addr": "0.0.0.0:18011",
  "agents": {
    "autofilm": {
      "type": "native",
      "endpoint": "http://autofilm-core:3100/v1/conversation/events",
      "api_key": "adapter-to-core-secret",
      "outbound_token": "core-to-adapter-secret",
      "allowed_users": ["*"],
      "timeout_seconds": 180
    }
  }
}
```

两个令牌必须不同。`api_key` 只认证 WeClaw 到 Core；
`outbound_token` 只认证 Core 到 WeClaw。

多人申请模式需要让未知联系人消息到达 Core，WeClaw 可在私有容器网络中使用
`allowed_users: ["*"]`。Core 对未知身份仍默认拒绝，管理员必须在成员页面绑定。

## 入站

WeClaw 发送扁平事件字段：

- `provider`、`provider_instance_id`
- `conversation_id`、`sender_id`
- `message_id`、`message_type`、`text`
- `attachments`、`timestamp`、`capabilities`

Core 以 `event_id` 去重。重复请求返回第一次保存的响应。

发送 `/clear` 可清除当前聊天对应的 AutoFilm 上下文。WeClaw 也接受 `/new`，
Telegram Adapter 也接受 `/reset`；Adapter 会把这些命令转换为
`conversation.reset`，Core 删除该会话的历史消息。

Agent 最终回复可能同时包含文字和 Core 短期媒体 URL。Core 在返回 Adapter 前提取
`AUTOFILM_MEDIA_BASE_URL/v1/media/{token}`，生成独立的 `image` 消息，并从文字
消息中移除该容器地址。外部网页链接不受影响。

WeClaw 使用结构化消息的 `media_url` 下载并发送微信图片；Telegram Adapter 先从
Core 下载图片，再以 multipart 上传到 Bot API，因此 Docker 内部媒体地址不会交给
Telegram 服务器读取。Adapter 不需要解析 Agent 的自然语言或识别某一种模型输出格式。

## 主动消息

Core 调用 Adapter 的 `POST /v1/messages`。任务完成通知经过持久化 Outbox。
115 二维码使用短期随机 URL，读取次数按管理员通知目标数量分配，过期后自动清理。

`AUTOFILM_MEDIA_BASE_URL` 必须是 Adapter 容器能够访问的 Core URL。

## Telegram

仓库内 `apps/telegram-adapter` 已实现独立 Telegram Bot 容器。它使用相同入站和
主动消息接口，配置与会话 ID 规则见 `telegram-adapter.md`。

## 其他平台

Telegram、微信之外的平台只需实现相同 HTTP 协议。平台 Token、Webhook、
消息格式和媒体上传属于 Adapter，不进入 Core。
