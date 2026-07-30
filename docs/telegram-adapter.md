# Telegram Adapter

Updated: 2026-07-29

## 职责

Telegram Adapter 是独立容器，不属于 Core 进程。它负责：

- 使用 Bot Token 调用 Telegram Bot API。
- 通过 long polling 接收私聊、群组和论坛 Topic 消息。
- 将 Telegram 标识转换为 Native Message Service `2026-07-01` 事件。
- 接收 Core 的 `/v1/messages` 主动通知并发送到原会话。
- 将 `/clear` 和 `/reset` 转换为 `conversation.reset`。

Core 不保存 Bot Token。成员审批、Agent 会话、任务和 Outbox 仍保存在 Core。

## 配置

Telegram Adapter 默认随 Core 启动。未配置时只提供内部初始化接口，不读取
Telegram 更新。

管理员只需要：

1. 在 Telegram 的 `@BotFather` 中发送 `/newbot` 创建机器人。
2. 打开 Core“聊天渠道”，选择 Telegram Bot。
3. 粘贴 BotFather 返回的 Bot API Token，点击“连接 Telegram”。

Core 会生成两组不同的随机服务令牌，并通过私有 Docker 网络把 Token 和服务令牌
交给 Adapter。Adapter 先调用 Telegram `getMe` 验证机器人身份，成功后将配置保存到
自己的 `telegram-data` 数据卷。Core 只保存服务令牌的哈希或加密值，不保存 Bot
Token。

环境变量初始化仍作为无界面部署的兼容方式保留，但不是管理界面的正常流程。

## 标识映射

- `provider`：固定为 `telegram`
- `provider_instance_id`：默认 `telegram-main`
- `sender_id`：Telegram 用户 ID
- 普通会话 `conversation_id`：Telegram Chat ID
- 论坛 Topic `conversation_id`：`<chat-id>:topic:<thread-id>`
- `event_id`：实例 ID 与 Telegram Update ID 的组合

Core 按 `event_id` 去重。Adapter 持久化最后完成的 Telegram Update offset，重启后
从该位置继续读取。不同会话并发执行，同一会话保持消息顺序。

`/new`、`/clear` 和 `/reset` 都会转换为 `conversation.reset`。

## 当前边界

- 接收附件时只将类型和文件名告知 Core；Core 当前仍只处理文本语义。
- 发送图片、视频、音频和文件时，Telegram 直接读取 Core 提供的短期媒体 URL。
- 当前使用 long polling，不要求公网 webhook。
- Adapter 的初始化接口不映射到宿主机端口。首次配置仅允许从私有容器网络调用；
  配置完成后的更换操作必须使用当前 Core → Adapter 服务令牌。
