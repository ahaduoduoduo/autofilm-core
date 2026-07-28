# Native chat adapters

Updated: 2026-07-28

Core 实现 WeClaw `Native Message Service 2026-07-01`。完整通用协议也记录在
WeClaw fork 的 `docs/native-services.md`。

## WeClaw 配置

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

## 主动消息

Core 调用 Adapter 的 `POST /v1/messages`。任务完成通知经过持久化 Outbox。
115 二维码使用短期随机 URL，默认最多读取五次，过期后自动清理。

`AUTOFILM_MEDIA_BASE_URL` 必须是 Adapter 容器能够访问的 Core URL。

## 其他平台

Telegram、微信之外的平台只需实现相同 HTTP 协议。平台 Token、Webhook、
消息格式和媒体上传属于 Adapter，不进入 Core。当前仓库尚未提供 Telegram
参考 Adapter，状态见 `TODO.md`。
