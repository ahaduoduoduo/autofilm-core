# 115 instant offline retry

Updated: 2026-07-30

## 行为

115 离线下载在本系统中通常是云端秒传，不是由 Core 等待完整文件下载。用户确认
版本后，Agent 将首选磁力和最多八个同内容备用磁力一起写入一个 Core 任务。

Core 每 2 秒读取 OpenList 的内存任务快照。默认规则是：

1. 首选磁力提交后等待 20 秒。
2. OpenList 返回任务结束时间后，Core 将任务标记为完成。进度达到 100% 但任务仍
   在整理或转存时继续视为运行中。
3. 任务明确失败，或者超过时限仍未完成，Core 调用
   `POST /api/autofilm/offline-tasks/delete`。
4. OpenList 取消本地任务，并通过离线下载驱动删除 115 中对应任务。
5. Core 提交下一个备用磁力，继续使用同一条业务任务记录。
6. 没有备用磁力后，任务才进入失败状态并发送通知。

每次尝试的 URL、结束时间和失败原因保存在任务 `metadata.attempts` 中。重试不重新
调用 AI，不重新搜索 Jackett，也不产生新的成员任务。

## 边界

- 自动更换只默认用于 `115 Cloud` 和 `115 Open`。
- 备用磁力必须由 Agent 从同一内容、同一季集范围和相近质量的搜索结果中选择。
- 任务状态读取只访问 OpenList 内存，不列举 115 目录。
- 进度百分比不用于推断任务终态；只有 OpenList 明确结束的任务才触发成员通知和
  Jellyfin 远端目录刷新。
- 已进入完成、失败或取消状态的 Core 任务不会被延迟到达的运行中快照改回非终态。
- 删除接口只接受离线下载任务 ID，不删除目标目录中的文件。
- 20 秒可在 OpenList 服务配置中调整为 10～120 秒，也可以关闭自动更换。

## 相关模块

- `apps/server/src/agent/toolsets/openlist.ts`：保存候选磁力和尝试元数据。
- `apps/server/src/tasks/progress-worker.ts`：短时判定、删除和重试。
- `apps/server/src/integrations/openlist.ts`：受限任务删除接口。
- OpenList fork `server/handles/autofilm.go`：删除服务端和 115 离线任务。
