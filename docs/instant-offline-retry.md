# 115 instant offline timeout and fallback selection

Updated: 2026-07-30

## 行为

115 离线下载在本系统中通常是云端秒传，不是由 Core 等待完整文件下载。用户确认
版本后，Agent 将首选磁力和最多八个同内容备用磁力一起写入一个 Core 任务。

Core 每 2 秒读取 OpenList 的内存任务快照。默认规则是：

1. 首选磁力提交后等待 40 秒。
2. 只有 OpenList 返回 `StateSucceeded`，Core 才将任务标记为完成。进度达到
   100% 或出现结束时间，但状态仍在整理或转存时，继续视为运行中。
3. 任务明确失败，或者超过时限仍未完成，Core 调用
   `POST /api/autofilm/offline-tasks/delete`。
4. OpenList 取消本地任务，并通过离线下载驱动删除 115 中对应任务。
5. Core 将业务任务改为 `waiting`，向原聊天发送尚未尝试的备用资源列表。
6. 成员明确选择后，Agent 调用 `resume_offline_download`，继续使用同一条业务
   任务记录；成员未选择时不提交任何备用资源。
7. 没有备用资源时，任务进入失败状态并发送通知。

每次尝试的 URL、结束时间和失败原因保存在任务 `metadata.attempts` 中。继续任务
不重新搜索 Jackett，也不产生新的成员任务。

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
- 备用磁力必须由 Agent 从同一内容、同一季集范围和相近质量的搜索结果中选择。
- 任务状态读取只访问 OpenList 内存，不列举 115 目录。
- 进度百分比不用于推断任务终态；只有 OpenList `StateSucceeded` 才触发
  Jellyfin 远端目录刷新。
- 已进入完成、失败或取消状态的 Core 任务不会被延迟到达的运行中快照改回非终态。
- 删除接口只接受离线下载任务 ID，不删除目标目录中的文件。
- 40 秒可在 OpenList 服务配置中调整为 10～120 秒，也可以关闭时限判断。
- 备用资源列表只表示可选项，不授予 Core 自动提交权限。

## 相关模块

- `apps/server/src/agent/toolsets/openlist.ts`：保存候选磁力和尝试元数据。
- `apps/server/src/tasks/progress-worker.ts`：短时判定、删除和等待成员选择。
- `apps/server/src/tasks/download-completion-worker.ts`：等待 Jellyfin 导入并恢复
  原 Agent 会话。
- `apps/server/src/integrations/openlist.ts`：受限任务删除接口。
- OpenList fork `server/handles/autofilm.go`：删除服务端和 115 离线任务。
