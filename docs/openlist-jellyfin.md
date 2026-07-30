# OpenList and Jellyfin interaction

Updated: 2026-07-30

## 文件职责

Core 不读取具体网盘对象 ID。离线下载目标使用 OpenList 绝对路径，例如
`/115/movie`；Jellyfin 数据库中的远端路径使用 `openlist:///115/movie`。
`RemoteRefresh` 请求仍使用 `/115/movie`，由 Jellyfin 在保存时转换成 URI。

OpenList 内部决定路径属于 115、其他网盘或本地存储。115 Cookie
始终留在 OpenList 驱动。

## 三种独立操作

1. Core 向 OpenList 创建离线下载。
2. Core 短间隔读取 OpenList 内存任务进度。
3. 下载完成后，Core 显式调用 Jellyfin `RemoteRefresh`。

第 2 项不是目录扫描，不维护 Jellyfin 文件映射。OpenList 上传、移动、重命名和
删除文件时不会自动修改 Jellyfin。

管理员或 Agent 可显式调用 Jellyfin `RemoteRefresh`。OpenList 也保留一个显式
的 `/api/autofilm/jellyfin/scan` 操作，供管理员将指定路径导入 Jellyfin。两者都
不是常驻同步机制。

## 115 扫码

Core 使用 OpenList 管理端 AutoFilm 扫码 API：

- 创建会话。
- 读取状态。
- 读取二维码 PNG。

扫码成功后 OpenList 使用该 Storage 原有 `QRCodeSource`，校验新 Cookie，
更新驱动字段并保存 Storage。Core 不接收 Cookie。

OpenList 不执行低频 115 凭据检查。真实文件操作返回 HTTP 405 时，115 驱动记录
明确的 `risk_controlled` 状态；Core 只读取这个本地状态，并向所有已配置且已有
管理员身份的聊天渠道发送一次通知。扫码成功或后续真实请求恢复成功时，OpenList
清除标记。

管理界面中的 Storage ID 只用于选择需要重新认证的 OpenList Storage，
不会写入 Jellyfin 条目，也不会成为媒体路径的一部分。

## 任务状态

Core 保存 OpenList 返回的任务 ID、标题、成员、目标目录和通知目标。
Core 通过受限的 `GET /api/autofilm/offline-tasks` 读取内存任务快照；该接口
不列目录、不读取 115 文件对象，也不开放任务取消或删除能力。OpenList 任务进入
终态后 Core 更新本地任务，并通过原聊天 Adapter 通知成员。

下载目标目录不由 Agent 自由填写。Core 根据 OpenList 服务配置的媒体库根目录、
TMDB ID、媒体类型和季号生成目录；完整规则见
[media-download-paths.md](media-download-paths.md)。

## 字幕管理

Agent 不把 OpenList 路径作为字幕目标。Core 先从 Jellyfin 取得 Movie 或 Episode ID，
再把字幕内容提交给 Jellyfin 标准字幕接口：

- 本地媒体使用 Jellyfin 原生字幕保存和自动命名逻辑。
- `openlist:///` 媒体由 Jellyfin AutoFilm 字幕服务上传到对应 OpenList 目录，
  自动选择未占用的语言文件名，并立即写入媒体流记录。
- 删除和替换使用 Core 生成的不可变 `subtitle_ref`。Core 执行前重新读取 Jellyfin
  字幕并校验文件摘要，内部解析当前流位置；Agent 不使用数字流序号。Core 不直接
  删除 OpenList 文件。

因此字幕新增、替换和删除后不调用 `RemoteRefresh`。下载完成后的媒体目录导入仍使用
`RemoteRefresh`，两种操作互不替代。

## 媒体删除

Core 的 `delete_jellyfin_items` 只接受 Jellyfin `Movie` 或 `Episode` ID：

- 本地媒体由 Jellyfin 删除实际文件并移除条目。
- `openlist:///` 媒体由 Jellyfin 先删除 OpenList 路径；OpenList 返回失败时保留
  Jellyfin 条目。
- 电影或单集存在多个版本时，`get_jellyfin_media_info` 返回的每个
  `MediaSources[].Id` 是该版本的精确删除目标。删除旧版时不能使用未经核对的展示
  条目 ID。
- 重复剧集通过 `list_jellyfin_episodes` 比较季集号、路径和媒体流后，批量提交需要
  删除的 Episode ID；一个目标失败不阻止其余目标。
- Series、Season、媒体库和目录删除不向 Agent 开放，避免自然语言歧义删除整个
  远端目录。

媒体删除会改变实际存储，Agent 必须先向成员列明目标并取得明确同意。删除外挂字幕
不使用该工具，继续通过 `subtitle_ref` 调用 `delete_jellyfin_subtitles`。
