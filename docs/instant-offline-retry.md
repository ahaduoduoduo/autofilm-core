# 115 instant offline timeout and fallback selection

Updated: 2026-07-31

## 行为

115 离线下载在本系统中通常是云端秒传，不是由 Core 等待完整文件下载。用户确认
版本后，Agent 将 Jackett 首选候选 ID 和最多八个同内容备用候选 ID 交给 Core。
Core 在内网读取候选的 `.torrent` 下载入口并计算 BitTorrent v1 infohash；已有
magnet 也必须通过 v1 校验。OpenList 最终只接收 magnet，Jackett URL 不会离开
Core。用户直接提供磁力时不经过 Jackett，但使用相同校验。

OpenList 创建的本地任务可能先在内部队列等待。只有离线下载驱动成功调用 115 并取得
provider task ID（115 使用 infohash）后，才表示 115 已接受任务。Core 每 2 秒读取
OpenList 的内存任务快照。默认规则是：

1. 首选候选转换为 magnet 后，OpenList 创建本地提交任务；这个阶段不计算秒传时限。
2. OpenList 成功取得 `provider_task_id` 和 `provider_submitted_at` 后，Core 才开始
   计算 40 秒。
3. 只有 OpenList 返回 `StateSucceeded`，Core 才将任务标记为完成。进度达到
   100% 或出现结束时间，但状态仍在整理或转存时，继续视为运行中。
4. 任务明确失败，或者从 115 接受时刻起超过时限仍未完成，Core 调用
   `POST /api/autofilm/offline-tasks/delete`。
5. OpenList 取消本地任务；存在 provider task ID 时再通过离线下载驱动删除 115
   对应任务。尚未被 115 接受的任务只取消 OpenList 本地任务。
6. Core 将业务任务改为 `waiting`，向原聊天发送尚未尝试的备用资源列表。
7. 成员明确选择后，Agent 调用 `resume_offline_download`，继续使用同一条业务
   任务记录；成员未选择时不提交任何备用资源。
8. 没有备用资源时，任务进入失败状态并发送通知。

每次尝试的候选 ID、Jackett 标题、OpenList 本地任务 ID、provider task ID、115
接受时间、结束时间和失败原因保存在任务 `metadata.attempts` 中。继续任务不重新搜索
Jackett，也不产生新的成员任务。OpenList 本地任务在 provider task ID 出现前失败时，
状态会明确说明“115 未确认接受该资源”，不会报告为 40 秒超时。

备用资源提示由进度 Worker 通过 Outbox 主动发送，不伪装成 Agent 历史消息。成员
随后只回复序号、资源名或确认使用备用资源时，Agent 必须读取
`list_download_tasks`，根据 `awaitingFallbackSelection`、`attemptIndex` 和
`downloadCandidates` 解释选择。展示名称使用保存的 Jackett `Title`，不从 magnet
`dn` 或下载 URL 推断。只确认使用备用资源但未指定具体项时，使用第一个尚未尝试的
候选。

## 成功后的处理

OpenList 成功快照同时返回真实生成的 `result_path`。Core 使用该精确路径调用
Jellyfin `RemoteRefresh`，并等待接口返回成功。最终聊天通知不会在
`StateSucceeded` 到达时提前发送。

同一次单任务或批量任务带有不可变工作流 ID。该工作流内所有视频均完成 Jellyfin
导入后，Core 向原聊天会话加入后台事件：

- 此前已经准备并认可字幕：Agent 继续定位 Jellyfin 条目并放置字幕。
- 视频已有合适内封字幕、成员不需要字幕、没有满意字幕或此前没有字幕计划：
  不搜索、不上传字幕，直接报告视频入库。
- 字幕处理失败：分别报告视频已入库和字幕失败项，不把视频任务误报为失败。

## 边界

- 40 秒时限判断只默认用于 `115 Cloud` 和 `115 Open`。
- 备用候选必须由 Agent 从同一内容、同一季集范围和相近质量的搜索结果中选择。
- Core 最多读取 32 MiB 的 torrent，最多跟随 5 次重定向；纯 BitTorrent v2 torrent
  因没有 v1 infohash 而拒绝提交，v1 和 hybrid torrent 均可转换。
- 任务状态读取只访问 OpenList 内存，不列举 115 目录。
- `provider_task_id` 只用于区分提交阶段和 115 已接受阶段，不建立媒体文件对象映射。
- 进度百分比不用于推断任务终态；只有 OpenList `StateSucceeded` 才触发
  Jellyfin 远端目录刷新。
- 已进入完成、失败或取消状态的 Core 任务不会被延迟到达的运行中快照改回非终态。
- 删除接口只接受离线下载任务 ID，不删除目标目录中的文件。
- 40 秒可在 OpenList 服务配置中调整为 10～120 秒，也可以关闭时限判断。
- 备用资源列表只表示可选项，不授予 Core 自动提交权限。
- Agent 读取任务时会删除历史任务中的 Jackett URL、API Key、magnet 和尝试记录里的
  原始 URL。

## 相关模块

- `apps/server/src/agent/toolsets/openlist.ts`：解析候选 ID、保存结构化候选和尝试
  元数据。
- `apps/server/src/integrations/jackett.ts`：管理短期候选缓存并读取 Jackett 下载
  入口。
- `apps/server/src/integrations/torrent-magnet.ts`：解析 torrent 原始 `info` 字典并
  生成 v1 magnet。
- `apps/server/src/tasks/download-candidates.ts`：读取新旧候选格式并过滤 Agent
  可见的敏感字段。
- `apps/server/src/tasks/progress-worker.ts`：provider 接受时间判定、删除和等待成员选择。
- `apps/server/src/tasks/download-completion-worker.ts`：等待 Jellyfin 导入并恢复
  原 Agent 会话。
- `apps/server/src/integrations/openlist.ts`：受限任务删除接口。
- OpenList fork `server/handles/autofilm.go`：删除服务端和 115 离线任务。
