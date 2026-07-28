# OpenList and Jellyfin interaction

Updated: 2026-07-28

## 文件职责

Core 不读取具体网盘对象 ID。离线下载目标使用 OpenList 绝对路径，例如
`/115/movie`；Jellyfin 数据库中的远端路径使用 `openlist:///115/movie`。
`RemoteRefresh` 请求仍使用 `/115/movie`，由 Jellyfin 在保存时转换成 URI。

OpenList 内部决定路径属于 115、其他网盘或本地存储。115 Cookie
始终留在 OpenList 驱动。

## 三种不同事件

1. Core 向 OpenList 创建离线下载。
2. Core 每 15 秒读取 OpenList 内存任务进度。
3. OpenList 在文件变更后直接向 Jellyfin 发送对象事件。

第 2 项不是目录扫描，不维护 Jellyfin 文件映射。第 3 项替代旧版精准刷新插件和
Core 目录轮询。

管理员或 Agent 仍可显式调用 Jellyfin `RemoteRefresh`。它用于人工指定远端路径，
不是常驻同步机制。

## 115 扫码

Core 使用 OpenList 管理端 AutoFilm 扫码 API：

- 创建会话。
- 读取状态。
- 读取二维码 PNG。

扫码成功后 OpenList 使用该 Storage 原有 `QRCodeSource`，校验新 Cookie，
更新驱动字段并保存 Storage。Core 不接收 Cookie。

管理界面中的 Storage ID 只用于选择需要重新认证的 OpenList Storage，
不会写入 Jellyfin 条目，也不会成为媒体路径的一部分。

## 任务状态

Core 保存 OpenList 返回的任务 ID、标题、成员、目标目录和通知目标。
OpenList 任务进入终态后 Core 更新本地任务，并通过原聊天 Adapter 通知成员。
