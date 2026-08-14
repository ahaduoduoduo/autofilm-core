# 媒体清单、TMDB 详情与成员长期记忆

Updated: 2026-08-14

## Jellyfin 电影版本清单

`query_jellyfin_movies` 从 Jellyfin `/Items` 分页读取 Movie、Provider ID、
MediaSources 和 MediaStreams。Core 将每个 MediaSource 展开为一个实际版本。

返回信息包括：

- 展示条目 ID、可删除版本 ID 和 MediaSource ID；
- 标题、年份、TMDB/IMDb ID；
- 本地或 `openlist:///` 路径；
- 实际宽高、分辨率类别、容器、编码、HDR、码率和大小；
- 各音轨的语言、编码、Profile、声道和标题。

读取过程只访问 Jellyfin 数据库 API，不访问 OpenList，也不探测远端文件。宽高缺失
的版本归入 `unknown`。

分辨率判断兼容宽银幕裁切：

- 3840×1600、4096×1716 等归入 2160p；
- 3440×1440 归入 1440p；
- 1920×800、2560×1080 等归入 1080p；
- 1280×536、1280×720 等归入 720p。

工具最多返回 25 个版本一页，通过 `page` 继续读取。

## BoxSet 合集详情

BoxSet 是 Jellyfin 的虚拟合集，不是电影文件，因此没有分辨率、码率或音轨，也不会
计入 `query_jellyfin_movies` 的电影及未知分辨率统计。

`search_jellyfin` 可以返回 BoxSet。取得 BoxSet ID 后，
`get_jellyfin_boxset_details` 分页读取其成员电影，并对每个成员展开 MediaSource，
返回路径、实际分辨率、HDR、编码、码率、大小和音轨，同时给出合集内各分辨率数量。
该工具只读；资源升级和删除仍只接受具体 Movie 或 Episode ID。

## 重复电影

`find_duplicate_jellyfin_movies` 与分辨率查询共用相同的版本展开和质量事实，不维护
第二套判断逻辑。

确定重复：

- TMDB ID 相同；
- IMDb ID 相同；
- Jellyfin 已将多个 MediaSource 识别为同一电影版本。

疑似重复：

- 标准化标题和年份相同；
- 没有一致的 Provider ID。

疑似重复可能是导演剪辑版、院线版、上下集或同名作品。工具本身只读；删除继续通过
`delete_jellyfin_items`，并要求用户先确认具体版本 ID 和路径。

版本按像素数量、码率排列只为方便查看，不生成质量评分。最终判断还需要考虑 HDR、
来源、编码、音轨、字幕和剪辑差异。

## TMDB 分层详情

`get_tmdb_metadata` 使用同一参数结构读取四个层级：

```text
movie + tmdb_id
tv + tmdb_id
tv + tmdb_id + season_number
tv + tmdb_id + season_number + episode_number
```

返回 TMDB 原始评分、评分人数、剧情简介和上映/播出日期。配置语言的简介为空时再读取
英文，并通过 `overviewLanguage` 标明来源。评分为零或字段缺失时返回 `null`，不使用
单集平均值替代单季评分。

## 当前时间

每次主 Agent 和追更 Agent 请求都动态加入：

- Asia/Shanghai 本地日期时间；
- 同一时刻的 ISO 时间。

涉及今天、当前、是否已经播出、上映倒计时和追更日期判断时，主提示词仍要求调用
`get_current_time`。动态时间用于防止模型使用过期常识，工具结果用于精确判断。

## 会话上下文与长期记忆

影视资料查询得到的 TMDB ID、Jellyfin Item ID、任务状态和字幕引用，统一作为普通
会话消息进入 Pi 式滚动上下文。项目不再维护影视主题状态或主题摘要。较早前缀由唯一
的 `conversation.compactor` 检查点替代，近期消息按 Token 预算保留原文，原始记录
继续保存在 `messages`。

成员长期偏好由 `user_memories` 独立保存，并在每次主模型调用时与 `agent.main`、当前
时间一起重新注入。长期记忆不经过会话压缩，也不依赖近期消息是否仍在原始尾部。
`/new`、`/clear` 和 `/reset` 只清除当前会话消息及压缩检查点，不删除成员长期记忆。

详细边界见 `context-management.md`。
