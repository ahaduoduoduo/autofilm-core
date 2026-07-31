# 批量画质升级检查与成员长期记忆

Updated: 2026-07-31

## 批量升级检查的职责

批量检查只回答“现有电影是否搜索到目标分辨率资源”，不下载文件，也不修改
Jellyfin。实际升级仍使用 `search_media_upgrade_candidates`、用户确认和
`start_media_upgrades`。

典型请求是检查全部 1080p 电影是否存在 4K 版本：

1. Agent 使用 `list_jellyfin_upgrade_check_targets` 以每页 100 项读取
   `resolution=1080p` 的紧凑列表。这个工具省略媒体流、音轨等批量检查不需要的字段，
   避免清单本身占满工具响应。
2. Agent 把每个版本的 Jellyfin ID、标题、原始标题、年份和当前分辨率组成一个
   `targets` 数组，一次调用 `start_bulk_media_upgrade_check`。单个任务最多 1000 项。
3. Core 为每项生成独立 UUID，并使用“原始标题或显示标题 + 年份”构造 Jackett
   搜索词。Agent 不填写 Jackett 查询语法。
4. 后台 Worker 每批领取 8 项并发搜索。单项网络失败执行一次有限重试；仍失败则只
   标记该项失败，不影响其他电影。
5. Core 从 Jackett 原始标题识别目标分辨率标记：2160p/4K/UHD、4320p/8K，或
   1080p/1080i。除目标分辨率外不进行评分、码率、来源、发行组或大小过滤。
6. 全部项目结束后，Core 恢复提交任务的聊天，让 Agent 分页读取命中结果并发送通知。

任务和逐项状态保存在 `media_upgrade_check_jobs`、
`media_upgrade_check_items`。Core 重启后，超过 10 分钟仍处于 `running` 的项目可以
重新领取。重复执行 Jackett 查询是只读操作，不会产生重复下载。

## 结果大小控制

`get_bulk_media_upgrade_check_results` 只返回 `matched` 项：

- 未搜索到目标分辨率的电影只进入 `noMatch` 计数，片名不进入模型上下文。
- 查询失败项只进入 `failed` 计数，不能被误报为没有资源。
- 每页默认和最大均按 10 部电影设计。
- 每部电影保存完整命中数量，但只向 Agent 返回按 Jackett 原始大小顺序排列的前三个
  样例资源。
- 最多保存每部电影前 20 个命中样例，且不保存 Jackett URL、API Key 或 magnet。
- 返回 `hasMore`、`nextPage` 和稳定 `jobId`。用户可按页查看，或指定片名进入标准
  单片升级搜索。

这些限制避免数百部电影及其全部候选进入一次工具结果而被供应方截断。它也保留了
最终选择所需的信息边界：批量任务负责发现，标准升级搜索负责取得最新的完整候选。

## 成员长期记忆

长期记忆保存在 `user_memories`，每条记录包含：

- `id`：修改或删除时使用的稳定 UUID；
- `user_id`：成员隔离边界；
- `category`：`preference`、`profile`、`constraint` 或 `note`；
- `content`：一条独立的长期事实；
- 创建和更新时间。

行为规则：

1. 只有成员明确要求“记住”或保存以后持续适用的偏好时，Agent 才调用
   `add_user_memory`。一次性选择和举例不自动写入。
2. 每轮主 Agent 请求都会把当前成员的记忆加入系统上下文，所以新会话无需先调用
   读取工具。
3. 现有记忆包含 `memory_id`。偏好改变时调用 `update_user_memory`，避免同时保留互相
   冲突的旧内容和新内容。
4. 只有成员明确要求忘记时调用 `delete_user_memory`。
5. `/new`、`/clear` 和 `/reset` 只删除当前会话消息及影视主题摘要，不操作
   `user_memories`。
6. 每名成员最多 100 条，每条最多 1000 个字符；注入模型的长期记忆最多 16000 个
   字符，防止长期使用后无限扩张上下文。

用户删除时，外键级联删除该用户的长期记忆和批量检查任务。不同成员无法通过 Agent
工具读取、修改或删除彼此的数据。
