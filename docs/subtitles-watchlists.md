# 字幕、验证码与追更

Updated: 2026-07-30

## 字幕搜索与评价

`search_subtitle` 先解析 SubHD 搜索页，统计结果关联的影片页 ID，再读取该影片页的
完整字幕列表。影片页不可用时才退回搜索页。候选包含稳定字幕 ID、语言、格式、下载
量、评分和评论数量。

`get_subtitle_detail` 返回说明、适配版本、评分、顶层评论和评论回复。发送给 Agent
前会把用户名替换为作者和临时编号，并合并重复评论，避免无关身份信息占用上下文。

## 临时工作区

一次字幕任务使用一个成员级 workspace：

1. `create_subtitle_workspace` 创建空工作区。
2. 一个或多个 `fetch_subtitle_archive` 使用相同 `workspace_id` 下载字幕包。
3. 每个包解压后保留来源字幕 ID、压缩包名和完整相对目录。
4. `get_subtitle_workspace` 返回每个文件的不可变 `workspace_file_id`、集号、语言、
   格式和大小。工作区不生成或接受数字序号。
5. Agent 选择文件，并将文件 UUID 与 Jellyfin Movie/Episode ID 列表提交给
   `prepare_subtitle_placements`。
6. 准备工具校验文件摘要、Jellyfin 目标、重复配对和可选旧字幕引用，保存不可修改的
   计划，并返回包含文件名、完整相对路径和目标名称的最终映射表。
7. Agent 核对映射表后，仅使用 `workspace_id + placement_plan_id` 调用
   `place_subtitles`。执行阶段不重新接受文件列表。

workspace 不写 SQLite。文件位于 `/data/tmp/subtitles`，保留 24 小时；全部映射成功
后删除，部分失败时继续保留以便重试，服务重启后删除。

同一文件 UUID 默认只能使用一次。确需复用时，每个相关映射都必须显式设置
`allow_file_reuse=true`。完全重复的文件与条目配对始终拒绝。每项上传前重新校验文件
SHA-256；部分失败后用同一计划重试，已经成功的项不会再次上传。

## 解压与编码

ZIP 依次尝试 7z 和 unzip；RAR 依次尝试 7z 和 unrar；7z 使用 7z。无法从扩展名识别
但内容符合 ASS、SRT、VTT、MicroDVD SUB 或 VobSub IDX 的文件按直接字幕处理。

文本先处理 UTF-8、UTF-16 LE/BE BOM；严格 UTF-8 失败后使用 `iconv-lite` 的 GB18030
解码。GB18030 覆盖 GBK 和 GB2312。归一化后的 UTF-8 才进入广告清理、ASS 样式处理
和 Jellyfin 上传。SUP 以及二进制 SUB 保留原始字节。

## 验证码

不同字幕包的下载、解压和验证码识别可以并发执行。每个下载创建独立 SubHD session
ID、Cookie Jar 与临时下载页；响应 Cookie 只写回所属任务。SubHD 客户端只限制 HTTP
请求的开始间隔，不等待前一个响应结束，因此不同任务可以重叠执行，同时避免短时间
集中请求。每个请求最多使用独立视觉模型自动识别五次。仍然失败时：

- 图片通过 Outbox 发给发起请求的当前渠道；
- workspace 保存独立 `task_code` 和下载会话，保留 30 分钟；
- 图片文件名包含任务码，成员回复“任务码 图片字符”；
- Agent 使用该任务的 `workspace_id + task_code` 恢复对应下载；
- 等待人工输入不会阻止其他成员或其他 workspace 下载字幕。

验证码、Cookie 和图片不写数据库。

## 广告清理

每个被选中的 ASS、SSA、SRT 或 VTT 在上传前创建一次独立 AI 请求。请求不继承主
Agent 历史、不提供工具，并包含该字幕的全部对白、Comment 或时间轴事件。系统不使用
正则表达式预筛选候选行。

AI 请求失败或返回无法解析的数据时保留原字幕。SUP/PGS 和其他二进制字幕不执行文本
清理。

## Jellyfin 字幕管理

`list_jellyfin_subtitle_targets` 把电影或剧集转换为 Movie/Episode 目标 ID，并列出
现有外挂字幕流。每条外挂字幕使用基于条目和文件摘要的 `subtitle_ref`，Agent 不接收
Jellyfin 字幕流数字序号，也不填写 OpenList 视频路径。

`place_subtitles` 逐项调用 AutoFilm Jellyfin 的鉴权二进制流式字幕上传接口：

- 本地媒体由 Jellyfin 保存到媒体目录或内部元数据目录，并使用原生命名规则。
- `openlist:///` 媒体由 Jellyfin AutoFilm 字幕服务上传 OpenList，并立即保存新的
  外挂字幕流。
- ASS、SSA、SRT、VTT、SUP/PGS 等所有格式使用同一流式接口；请求不进行 Base64
  编码，也不受 ASP.NET Core 默认 30 MB JSON 请求限制。
- SUP/PGS 从 workspace 临时文件直接按流发送，不再整体读入 Core 内存；文本字幕
  在独立 AI 清理完成后，将清理结果作为读取流发送。
- Jellyfin 原生 JSON 字幕上传接口仅为 Jellyfin Web、第三方客户端和插件保留，
  AutoFilm Core 不再调用。
- 新字幕上传成功后才按可选 `replace_subtitle_ref` 删除旧字幕。
- 删除前重新读取 Jellyfin 条目并核对摘要；字幕流发生变化时拒绝按旧位置猜测。
- 单项失败不会停止其他映射；失败时返回具体执行阶段、底层网络原因和逐项结果，并
  保留 workspace。

纯删除使用 `delete_jellyfin_subtitles`。字幕新增、替换和删除都不调用目录刷新。

ASS 样式工具也从 Jellyfin 字幕流读取内容。黑边处理会调整 `PlayResY`、非对白样式
MarginV、pos/move/clip/org 坐标，并仅删除用户选定的行内字号或颜色覆盖，不删除斜体、
淡入淡出和卡拉 OK 等无关标签。结果作为新的 `chi.ass` 字幕交给 Jellyfin 保存。

## 追更

追更记录以成员 ID、TMDB 剧集 ID 和季号为唯一范围，长期保存：

- 原始条件文本。
- OpenList 目标目录。
- 分集播出日期和处理状态。
- 最初创建追更的消息目标。

定时任务只读取 TMDB 播出信息，不列举 OpenList 或直接访问网盘。出现已播未处理分集
时，Core 创建一次独立的只读 Agent 请求；该请求只允许检索 TMDB、Jackett、SubHD
和 Jellyfin，不能下载、上传、删除或刷新。结果明确返回 `[MATCH]` 后才通过 Outbox
通知成员并把分集标为已通知。

检查间隔由 `AUTOFILM_WATCHLIST_INTERVAL_SECONDS` 控制，默认 21600 秒，最小
300 秒。
